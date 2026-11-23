const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url');
const links=require('../path-links.js'),{resolveProjectPath}=require('../project-paths.cjs');
const {findProjectPaths,messagePaths}=require('../workbench/path-resolution.cjs');
test('Drive-prefixed Markdown links resolve as absolute Windows paths without a project root',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'relay-link-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const filename=path.join(directory,'review entry.html');await fs.writeFile(filename,'<!doctype html><title>Fixture</title>');
  const drive='/' + filename.replaceAll('\\','/');assert.equal(links.normalize(drive),filename.replaceAll('\\','/'));assert.equal(await resolveProjectPath('',drive),await fs.realpath(filename));assert.equal(await resolveProjectPath('',pathToFileURL(filename).href),await fs.realpath(filename));
  assert.equal(links.local('/X:/games/archive/index.html'),'X:/games/archive/index.html');assert.equal(links.local('/D:/games/review/README.md'),'D:/games/review/README.md');
});
test('Encoded spaces, line suffixes, balanced parentheses and literal percent signs remain unambiguous',()=>{
  assert.equal(links.local('/D:/Example%20Project/README.md',true),'D:/Example Project/README.md');assert.equal(links.normalize('D:/Project/file.md:18:2'),'D:/Project/file.md');assert.equal(links.normalize('D:/Project/file.md#L18'),'D:/Project/file.md');
  assert.equal(links.normalize('file:///D:/Project/percent%2520.md'),'D:/Project/percent%20.md');assert.equal(links.local('D:/Project/percent%20.md'),'D:/Project/percent%20.md');
  const result=links.links('[Open review](/D:/Project/build(old)/index.html) · [Notes](</X:/Example Project/README.md>)');assert.equal(result.length,2);assert.equal(result[0].value,'D:/Project/build(old)/index.html');assert.equal(result[1].value,'X:/Example Project/README.md');
});
test('Terminal parsing recognizes raw Markdown and plain paths but does not expose unsafe schemes or network file links',()=>{
  const result=links.links('[Open acceptance](/X:/games/arpg-archive/evidence/vfx-polish-youmu-shatter/r1/fixed-step-r4/index.html) · [Implementation](/D:/interests/games/arpg-youmu-shatter-review/docs/evidence/youmu-shatter-r1/README.md)');assert.deepEqual(result.map(r=>r.kind),['local','local']);assert(result[0].value.startsWith('X:/'));assert(result[1].value.startsWith('D:/'));
  assert.equal(links.links('See `docs/review.md` and https://example.com/review').length,2);
  for(const value of ['javascript:alert(1)','data:text/html,code','file://server/share/file.md','//server/share/file.md','file:///D:/bad%00file.md'])assert.equal(links.local(value,true),null);
  assert.equal(links.target('https://user:password@example.com/file'),null);
});

test('Plain text recognizes quoted/spaced Windows paths, relative files and directories without altering display ranges',()=>{
  const source='Read D:\\Example Project\\panel.png, "D:\\Example Project\\build"; docs/review.md:18:2 and ./output plus README.md and \u8bf4\u660e.txt.';
  const result=links.links(source,{plain:true});
  assert.deepEqual(result.map(x=>x.value),['D:\\Example Project\\panel.png','D:\\Example Project\\build','docs/review.md','./output','README.md','\u8bf4\u660e.txt']);
  assert.equal(source.slice(result[2].start,result[2].end),'docs/review.md:18:2');
  assert.equal(source.slice(result[0].start,result[0].end),'D:\\Example Project\\panel.png');
  assert.equal(links.links('version 1.2.3 and example.com or person@example.com',{plain:true}).length,0);
});

test('Plain paths preserve literal percent signs, URLs keep precedence and unsupported URI targets are not partially salvaged',()=>{
  assert.equal(links.links('D:/Project/percent%20.md',{plain:true})[0].value,'D:/Project/percent%20.md');
  const result=links.links('https://example.com/D:/foo.png. custom://host/path/foo.md',{plain:true});assert.equal(result.length,1);assert.equal(result[0].kind,'web');assert.equal(result[0].value,'https://example.com/D:/foo.png');
  assert.equal(links.links('[Missing support](custom://host/D:/foo.png)').length,0);
});

test('Project references try all roots and allow the user to disambiguate duplicate paths', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-paths-'));
  t.after(() => fs.rm(directory, {recursive:true,force:true}));
  const roots = [path.join(directory, 'first'), path.join(directory, 'second')];
  for (const root of roots) await fs.mkdir(path.join(root, 'src'), {recursive:true});
  const filename = path.join(roots[1], 'src', 'only here.js');
  await fs.writeFile(filename, '');
  const [only] = (await findProjectPaths('src/only here.js:18:2', roots)).candidates;
  assert.equal(only.path, await fs.realpath(filename));
  assert.equal(only.relative, path.join('src', 'only here.js'));
  for (const root of roots) await fs.writeFile(path.join(root, 'src', 'common.js'), '');
  assert.equal((await findProjectPaths('src/common.js', roots)).candidates.length, 2);
  assert.equal((await findProjectPaths('/srv/docs/common.js', roots)).candidates.length, 0);
  assert.equal((await findProjectPaths('../first/src/common.js', roots)).candidates.length, 0);
  await assert.rejects(findProjectPaths('file://server/share/common.js', roots));
});

test('Message paths disambiguate a basename before bounded suffix search', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-path-hints-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const paths = ['first/src/main.cjs', 'second, copy/src/main.cjs', 'node_modules/src/main.cjs'];
  for (const relative of paths) {
    const filename = path.join(root, relative);
    await fs.mkdir(path.dirname(filename), {recursive:true});
    await fs.writeFile(filename, '');
  }
  const hints = messagePaths({text:'Changed main.cjs.'}, [
    {status:'complete',paths:[paths[1]]},
    {status:'failed',paths:[paths[0]]},
  ]);
  const resolved = await findProjectPaths('main.cjs', [root], {getHints:()=>hints});
  assert.deepEqual(resolved.candidates.map(item => item.path), [await fs.realpath(path.join(root, paths[1]))]);
  const searched = await findProjectPaths('src/main.cjs#L12', [root]);
  assert.deepEqual(searched.candidates.map(item => item.relative).sort(), paths.slice(0, 2).map(value => path.normalize(value)));
  assert.equal(searched.incomplete, false);
  assert.equal((await findProjectPaths('main.cjs', [root], {maxEntries:1})).incomplete, true);
  assert.deepEqual([...messagePaths({text:'Changed [another file](<docs/start here.md>).'}, [{title:'Files: src/old.js'}])], ['src/old.js','docs/start here.md']);
  assert.deepEqual(links.links('See Dockerfile, LICENSE and /srv/project/docs/readme.md.', {plain:true}).map(item=>item.value),
    ['Dockerfile','LICENSE','/srv/project/docs/readme.md']);
});
