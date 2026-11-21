#!/usr/bin/env python3
"""Prepare, verify and atomically switch the managed Claude image without user-state mounts."""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid

CURRENT = 'windows-mcp-claude:local'
PREVIOUS = 'windows-mcp-claude:previous'
RUNTIME_BASE = 'windows-mcp-claude:runtime-base'
DIRECTORY = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'windows-mcp' / 'claude-updates'
VERSION = re.compile(r'^\d+\.\d+\.\d+$')
DOCKER = None


class UpdateError(Exception):
    pass


def atomic(filename, value):
    temporary = filename.with_name('.update-' + uuid.uuid4().hex)
    try:
        with temporary.open('x') as output:
            os.chmod(temporary, 0o600)
            json.dump(value, output)
        os.replace(temporary, filename)
    finally:
        temporary.unlink(missing_ok=True)


def read(name):
    try:
        filename = DIRECTORY / name
        if filename.stat().st_size > 65536:
            return {}
        return json.loads(filename.read_text())
    except (OSError, ValueError):
        return {}


def docker(args, timeout=20, log=None, required=True):
    global DOCKER
    if DOCKER is None:
        DOCKER = ['docker']
        if subprocess.run(DOCKER + ['info'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8).returncode:
            DOCKER = ['sudo', '-n', 'docker']
    result = subprocess.run(DOCKER + args, stdout=log or subprocess.PIPE, stderr=log or subprocess.PIPE,
                            text=True, timeout=timeout)
    if required and result.returncode:
        raise UpdateError('docker_command_failed')
    return result


def image_info(tag):
    result = docker(['image', 'inspect', tag], required=False)
    if result.returncode:
        return None
    data = json.loads(result.stdout)[0]
    return {'id': data['Id'], 'version': (data.get('Config', {}).get('Labels') or {}).get('io.relaydesk.claude.version')}


def image_version(tag):
    info = image_info(tag)
    if not info:
        raise UpdateError('image_missing')
    if VERSION.fullmatch(info.get('version') or ''):
        return info['version']
    result = docker(['run', '--rm', '--network', 'none', '--memory=256m', tag, 'claude', '--version'])
    match = re.search(r'\b(\d+\.\d+\.\d+)\b', result.stdout)
    if not match:
        raise UpdateError('invalid_cli_version')
    return match[1]


def latest_version():
    cached = read('release.json')
    if VERSION.fullmatch(cached.get('version', '')) and 0 <= time.time() - cached.get('at', 0) < 300:
        return cached['version']
    request = urllib.request.Request('https://api.github.com/repos/anthropics/claude-code/releases/latest',
                                     headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Relay-Desk-Updater'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            content = response.read(1048577)
        if len(content) > 1048576:
            raise ValueError('Release metadata too large.')
        data = json.loads(content)
        tag = data.get('tag_name', '')
        version = tag[1:] if tag.startswith('v') else tag
        if data.get('prerelease') or data.get('draft') or not VERSION.fullmatch(version):
            raise ValueError('Invalid release version.')
    except (OSError, ValueError, KeyError):
        raise UpdateError('release_query_failed')
    atomic(DIRECTORY / 'release.json', {'version': version, 'at': time.time()})
    return version


def active(job):
    if job.get('state') != 'running' or not isinstance(job.get('pid'), int):
        return False
    try:
        os.kill(job['pid'], 0)
        return True
    except OSError:
        return False


def status(check=False):
    job = read('status.json')
    if active(job):
        return job
    if job.get('state') == 'running':
        job.update(state='failed', reason='worker_interrupted')
        atomic(DIRECTORY / 'status.json', job)
    if not check:
        return job or {'state': 'idle', 'phase': 'idle'}
    installed = image_version(CURRENT)
    latest = latest_version()
    previous = image_info(PREVIOUS)
    prepared = read('prepared.json')
    result = {**job, 'state': job.get('state', 'idle'), 'phase': job.get('phase', 'idle'),
              'installed': installed, 'latest': latest, 'checkedAt': time.time() * 1000,
              'available': tuple(map(int, latest.split('.'))) > tuple(map(int, installed.split('.'))),
              'canRollback': bool(previous), 'preparedVersion': prepared.get('version', '') if prepared.get('sourceImageId') == image_info(CURRENT)['id'] else ''}
    atomic(DIRECTORY / 'status.json', result)
    return result


def resource_check():
    available = next(int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    if available < 1024 * 1024:
        raise UpdateError('insufficient_memory')
    disk = docker(['run', '--rm', '--network', 'none', '--memory=64m', CURRENT, 'df', '-Pk', '/']).stdout.strip().splitlines()
    if len(disk) < 2 or int(disk[-1].split()[3]) * 1024 < 2 * 1024 ** 3:
        raise UpdateError('insufficient_disk')


def prepare(target, source_id, phase):
    base = image_info(RUNTIME_BASE)
    last_applied = read('status.json').get('appliedImageId')
    if not base or (last_applied != source_id and base['id'] != source_id):
        docker(['tag', source_id, RUNTIME_BASE])
    prepared = read('prepared.json')
    if prepared.get('version') == target and prepared.get('sourceImageId') == source_id:
        info = image_info(prepared.get('tag', ''))
        if info and info['id'] == prepared.get('imageId'):
            return prepared['tag']
    resource_check()
    identifier = uuid.uuid4().hex
    container = 'relay-claude-update-' + identifier
    tag = 'windows-mcp-claude:candidate-' + identifier
    try:
        phase('downloading')
        docker(['create', '--name', container, '--init', '--memory=768m', '--memory-swap=896m',
                '--pids-limit=128', '--oom-score-adj=500', '--network', 'host', '--log-driver=none',
                '--env', 'RELAY_CLAUDE_TARGET=' + target, RUNTIME_BASE, 'bash', '-c',
                'claude install "$RELAY_CLAUDE_TARGET" && claude --version'])
        with (DIRECTORY / 'install.log').open('w') as log:
            os.chmod(DIRECTORY / 'install.log', 0o600)
            docker(['start', '-a', container], timeout=600, log=log)
        details = docker(['inspect', '--format', '{{.State.ExitCode}}', container]).stdout.strip()
        if details != '0':
            raise UpdateError('installer_failed')
        phase('verifying')
        docker(['commit', '--change', 'LABEL io.relaydesk.claude.version=' + target, container, tag], timeout=90)
        # Verify the actual binary; an image label alone is not evidence of installation.
        output = docker(['run', '--rm', '--network', 'none', '--memory=256m', tag, 'claude', '--version']).stdout
        if not re.search(r'\b' + re.escape(target) + r'\b', output):
            raise UpdateError('version_verification_failed')
        help_text = docker(['run', '--rm', '--network', 'none', '--memory=256m', tag, 'claude', '--help']).stdout
        for flag in ('--input-format', '--output-format', '--no-session-persistence', '--include-partial-messages', '--effort', '--safe-mode'):
            if flag not in help_text:
                raise UpdateError('protocol_verification_failed')
        reader = Path(__file__).with_name('read-usage.py')
        if reader.is_file() and (DIRECTORY.parent / 'claude' / '.credentials.json').is_file():
            phase('checking_usage')
            spec = importlib.util.spec_from_file_location('relay_update_usage', reader)
            usage = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(usage)
            usage.query_claude_usage(image=tag)
        info = image_info(tag)
        atomic(DIRECTORY / 'prepared.json', {'version': target, 'sourceImageId': source_id,
                                            'imageId': info['id'], 'tag': tag, 'at': time.time()})
        old_tag = prepared.get('tag', '')
        if old_tag != tag and re.fullmatch(r'windows-mcp-claude:candidate-[a-f0-9]{32}', old_tag):
            # Only remove our obsolete tag; referenced images and running containers survive.
            docker(['image', 'rm', old_tag], required=False)
        return tag
    except BaseException:
        docker(['image', 'rm', tag], required=False)
        raise
    finally:
        docker(['rm', '-f', container], required=False)


def worker(job_id):
    with (DIRECTORY / 'update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        job = read('status.json')
        if job.get('jobId') != job_id:
            return

        def phase(value):
            job.update(phase=value, updatedAt=time.time() * 1000)
            atomic(DIRECTORY / 'status.json', job)

        try:
            current = image_info(CURRENT)
            if not current:
                raise UpdateError('image_missing')
            operation = job['operation']
            if operation == 'rollback':
                previous = image_info(PREVIOUS)
                if not previous:
                    raise UpdateError('previous_missing')
                phase('switching')
                backup = 'windows-mcp-claude:rollback-' + job_id
                docker(['tag', current['id'], backup])
                try:
                    docker(['tag', previous['id'], CURRENT])
                    docker(['tag', current['id'], PREVIOUS])
                except BaseException:
                    docker(['tag', current['id'], CURRENT])
                    raise
                finally:
                    docker(['image', 'rm', backup], required=False)
                job.update(installed=image_version(CURRENT), reason='rolled_back', appliedImageId=previous['id'])
            else:
                installed = image_version(CURRENT)
                target = job['target']
                if tuple(map(int, target.split('.'))) <= tuple(map(int, installed.split('.'))):
                    job.update(installed=installed, reason='up_to_date')
                else:
                    tag = prepare(target, current['id'], phase)
                    if operation == 'prepare':
                        job.update(installed=installed, preparedVersion=target, reason='prepared')
                    else:
                        phase('switching')
                        if image_info(CURRENT)['id'] != current['id']:
                            raise UpdateError('image_changed')
                        docker(['tag', current['id'], PREVIOUS])
                        docker(['tag', tag, CURRENT])
                        job.update(installed=target, preparedVersion='', reason='updated', appliedImageId=image_info(CURRENT)['id'])
            job.update(state='complete', phase='complete', canRollback=bool(image_info(PREVIOUS)))
            job['available'] = tuple(map(int, job.get('latest', '0.0.0').split('.'))) > tuple(map(int, job['installed'].split('.')))
        except BaseException as error:
            job.update(state='failed', phase='failed', reason=str(error) if isinstance(error, UpdateError) else 'update_failed')
        finally:
            job['updatedAt'] = time.time() * 1000
            atomic(DIRECTORY / 'status.json', job)


def start(operation):
    with (DIRECTORY / 'update.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return status()
        existing = read('status.json')
        if active(existing):
            return existing
        current = status(check=True) if operation != 'rollback' else {**existing, 'installed': image_version(CURRENT), 'canRollback': bool(image_info(PREVIOUS))}
        if operation == 'rollback' and not current['canRollback']:
            raise UpdateError('previous_missing')
        identifier = uuid.uuid4().hex
        job = {**current, 'jobId': identifier, 'operation': operation, 'target': current.get('latest', current['installed']),
               'state': 'running', 'phase': 'queued', 'reason': '', 'updatedAt': time.time() * 1000}
        command = [sys.executable, str(Path(__file__).resolve()), 'worker', '--job', identifier]
        with (DIRECTORY / 'worker.log').open('a') as log:
            os.chmod(DIRECTORY / 'worker.log', 0o600)
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                       start_new_session=True, close_fds=True)
        job['pid'] = process.pid
        atomic(DIRECTORY / 'status.json', job)
        return job


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('check', 'status', 'update', 'prepare', 'rollback', 'worker'))
    parser.add_argument('--job')
    args = parser.parse_args()
    DIRECTORY.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        if args.action == 'worker':
            if not re.fullmatch(r'[a-f0-9]{32}', args.job or ''):
                raise UpdateError('invalid_job')
            worker(args.job)
        else:
            result = status(check=True) if args.action == 'check' else status() if args.action == 'status' else start(args.action)
            print(json.dumps(result))
    except (OSError, ValueError, subprocess.SubprocessError, UpdateError) as error:
        print(json.dumps({**read('status.json'), 'state': 'failed', 'phase': 'failed',
                          'reason': str(error) if isinstance(error, UpdateError) else 'operation_failed'}))
