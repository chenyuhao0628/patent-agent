from pathlib import Path
import re,subprocess,json,sys,urllib.parse,collections
# Read project documentation only; do not scan work materials or runtime content.
root=Path(__file__).resolve().parents[2]
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
files={root/f for f in tracked if f.endswith(('.md','.mdx')) and not f.startswith(('work/','resources/','1-'))}
files.update(root.glob('docs/**/*.md'));files.update(root.glob('evidence/documentation-audit-20261012/*.md'))
def headings(file):
 ids=set();seen=collections.Counter();fence=False
 for line in file.read_text().splitlines():
  if line.strip().startswith('```'):fence=not fence;continue
  if fence:continue
  m=re.match(r'^#{1,6}\s+(.+?)\s*#*$',line)
  if not m:continue
  h=m.group(1).lower().replace('`','');h=re.sub(r'<[^>]*>','',h);h=re.sub(r'[^\w\- ]','',h);h=h.replace(' ','-')
  n=seen[h];seen[h]+=1;ids.add(h+('-'+str(n) if n else ''))
 return ids
broken=[];links=0;external=0
for p in sorted(files):
 if not p.exists():continue
 for n,line in enumerate(p.read_text().splitlines(),1):
  for m in re.finditer(r'!?\[[^\]]*\]\(([^)\n]+)\)',line):
   url=m.group(1).strip();url=url[1:url.index('>')] if url.startswith('<') and '>' in url else url.split(' "')[0]
   if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',url):external+=1;continue
   target,_,anchor=url.partition('#');target=urllib.parse.unquote(target);anchor=urllib.parse.unquote(anchor)
   q=(p.parent/target).resolve() if target else p;links+=1
   if not q.exists():broken.append({'file':str(p.relative_to(root)),'line':n,'target':url,'reason':'missing file'})
   elif anchor and q.suffix in ('.md','.mdx') and anchor not in headings(q):broken.append({'file':str(p.relative_to(root)),'line':n,'target':url,'reason':'missing heading'})
result={'files':len(files),'localLinks':links,'externalLinksNotFetched':external,'broken':broken}
print(json.dumps(result,ensure_ascii=False,indent=2))
if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')

if broken: raise SystemExit(1)
