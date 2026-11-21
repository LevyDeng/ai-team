"""Read installed SKILL.md files from one SSH location."""

import base64
import json
import os
from pathlib import Path
import sys


def directories(path):
    if path.is_dir():
        return sorted((entry for entry in path.iterdir()
                       if not entry.name.startswith('.') and entry.is_dir()
                       and not entry.is_symlink()), key=lambda entry: entry.name.casefold())
    return []


def files_in(path, synced):
    for folder in directories(path):
        yield folder
    if synced:
        for namespace in directories(path / 'synced'):
            yield from directories(namespace)


def read_catalog(config):
    home = Path.home()
    definition = config['definition']
    directory = config['directory']
    state = None
    if config['managed'] and definition.get('managed'):
        engine = definition['managed']
        state = home / '.local' / 'state' / 'windows-mcp' / engine

    if directory:
        roots = [Path(directory).expanduser()]
    else:
        roots = [state / 'skills'] if state else []
        default = home / definition['home']
        base = Path(os.environ.get(definition.get('env', ''), str(default))).expanduser()
        roots.extend(base / relative for relative in definition['roots'])

    seen = set()
    catalog = []
    total = 0
    for root in roots:
        for folder in files_in(root, definition.get('synced', False)):
            filename = folder / 'SKILL.md'
            name = folder.name.casefold()
            if name in seen or not filename.is_file() or filename.is_symlink():
                continue
            with filename.open('rb') as file:
                contents = file.read(128 * 1024 + 1)
            if len(contents) > 128 * 1024:
                continue
            total += len(contents)
            if total > 1200 * 1024 or len(catalog) >= 500:
                raise ValueError('The skill catalog exceeds the import size limit. Choose a smaller skills folder.')
            item = {'name': folder.name, 'folder': str(folder),
                    'contents': base64.b64encode(contents).decode('ascii')}
            if state and state in folder.parents:
                item['runtimeFolder'] = str(Path('/home') / engine / 'state' / folder.relative_to(state))
            catalog.append(item)
            seen.add(name)
    return catalog


if __name__ == '__main__':
    try:
        print(json.dumps(read_catalog(json.loads(sys.argv[1]))))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
