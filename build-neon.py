# Собирает один файл index.mjs для Neon Functions: логика + хранилище + обработчик + интерфейс.
import json, os, zipfile, base64, sys
root = os.path.dirname(os.path.abspath(__file__))
rd = lambda p: open(os.path.join(root, p), encoding='utf-8').read()
assets = {}
mime = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'}
for f in sorted(os.listdir(os.path.join(root, 'public'))):
    assets['/' + f] = {'type': mime.get(os.path.splitext(f)[1], 'application/octet-stream'), 'body': rd('public/' + f)}
assets['/core.js'] = {'type': mime['.js'], 'body': rd('core.js')}
entry = '''
const CORE = globalThis.CORE;
const ASSETS = %s;
const SLUG = process.env.FUNCTION_SLUG || 'castle';
const PUBLIC = process.env.PUBLIC_URL || (process.env.NEON_BRANCH_ID && process.env.NEON_FUNCTION_HOST_SUFFIX ? 'https://' + process.env.NEON_BRANCH_ID + '-' + SLUG + process.env.NEON_FUNCTION_HOST_SUFFIX : '');
const handle = globalThis.CASTLE.createHandler({
  core: CORE, store: globalThis.CASTLE.createHttpStore(process.env.DATABASE_URL), assets: ASSETS,
  secret: process.env.SESSION_SECRET, setupCode: process.env.SETUP_CODE || '', publicUrl: PUBLIC, appUrl: process.env.WEB_APP_URL || ''
});
export default { fetch: (request) => handle(request) };
''' % json.dumps(assets, ensure_ascii=False)
out = '// Сборка для Neon Functions. Не редактировать вручную: python3 build-neon.py\n' + rd('core.js') + '\n' + rd('store-http.js') + '\n' + rd('app-handler.js') + '\n' + entry
os.makedirs(os.path.join(root, 'dist'), exist_ok=True)
open(os.path.join(root, 'dist/index.mjs'), 'w', encoding='utf-8').write(out)
z = os.path.join(root, 'dist/function.zip')
with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf: zf.write(os.path.join(root, 'dist/index.mjs'), 'index.mjs')
print(os.path.getsize(z), 'bytes')

# ---- docs/: экран приложения для GitHub Pages (API — на Neon) ----
import shutil
API_URL = os.environ.get('CC_API', 'https://br-red-base-b9qm2axn-castle.compute.c-7.eu-central-1.aws.neon.tech')
docs = os.path.join(root, 'docs')
shutil.rmtree(docs, ignore_errors=True); os.makedirs(docs)
for f in os.listdir(os.path.join(root, 'public')):
    shutil.copy(os.path.join(root, 'public', f), docs)
shutil.copy(os.path.join(root, 'core.js'), docs)
open(os.path.join(docs, 'config.js'), 'w').write("window.CC_API = %s;\n" % json.dumps(API_URL))
open(os.path.join(docs, '.nojekyll'), 'w').write('')
print('docs/ ->', API_URL)
