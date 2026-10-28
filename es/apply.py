import re,os,sys
sys.path.insert(0,os.path.dirname(__file__)); from es import ES,AMBIGUOUS,SKIP_FILES
root=sys.argv[1]
pat=re.compile(r"""(?<![\w$])(['"`])((?:\\.|(?!\1).)*?)\1""")
CALL=re.compile(r"(\.call|_sendRequest|propertySet|get_cached_property|Variant)\(")
def inside_call(prefix):
    for m in reversed(list(CALL.finditer(prefix))):
        rest=prefix[m.end():]
        if rest.count('(')-rest.count(')')>=0: return True
    return False
total=0; used=set()
for d,_,fs in os.walk(root):
    for f in fs:
        if not f.endswith('.js') or f in SKIP_FILES: continue
        p=os.path.join(d,f); lines=open(p).read().split('\n'); changed=0
        for i,line in enumerate(lines):
            st=line.strip()
            if st.startswith(('//','*','/*','import ')) or 'console.' in line or 'logError' in line: continue
            def sub(m):
                global total
                q,s=m.group(1),m.group(2)
                if s not in ES: return m.group(0)
                if s in AMBIGUOUS and (inside_call(line[:m.start()]) or 'status ===' in line or 'const method' in line): return m.group(0)
                if s=='Brightness' and f!='alerts.js': return m.group(0)
                t=ES[s]
                if q=="'": t=t.replace("'", "\\'") if "'" not in s else t
                used.add(s); total+=1
                return q+t+q
            new=pat.sub(sub,line)
            if new!=line: lines[i]=new; changed+=1
        if changed: open(p,'w').write('\n'.join(lines)); print(f"{os.path.relpath(p,root)}: {changed} líneas")
print('reemplazos',total,'| sin usar:',sorted(set(ES)-used))
