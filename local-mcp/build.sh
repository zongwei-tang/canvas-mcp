#!/bin/sh
# Bundle gs-server.ts into the single file deployed as a Railway Function (gs-railway.ts).
set -e
cd "$(dirname "$0")"
../node_modules/.bin/esbuild gs-server.ts --bundle --platform=node --format=esm --packages=external --outfile=gs-bundle.ts
sed -e 's#from "cheerio"#from "cheerio@1.2.0"#' -e 's#from "zod"#from "zod@3.25.76"#' gs-bundle.ts > gs-railway.ts
python3 - <<'PY'
src = open("gs-railway.ts").read()
# drop upstream code the Gradescope-only server never calls (and the zod dependency with it)
a = src.index("  /**\n   * Analyze a natural language query"); b = src.index("};\n\n// ../src/cache.ts"); src = src[:a] + src[b:]
a = src.index('import { z } from "zod@3.25.76";'); b = src.index("var Logger = class"); src = src[:a] + src[b:]
src = src.replace("var cache = new WorkerCache();\n", "")
tail = 'export {\n  handleRequest\n};\n'
assert src.endswith(tail)
src = src[: -len(tail)] + "(globalThis as any).__handleRequest = handleRequest;\n"
open("gs-railway.ts", "w").write(src)
PY
