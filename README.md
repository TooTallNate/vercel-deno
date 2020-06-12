[<img src="https://assets.vercel.com/image/upload/v1588805858/repositories/vercel/logo.png" height="96"><img src="https://raw.githubusercontent.com/denolib/high-res-deno-logo/master/deno_hr_circle.svg" height="104" />](https://github.com/TooTallNate/vercel-deno)

# Vercel Deno Runtime (`vercel-deno`)

The Deno Runtime compiles a TypeScript or JavaScript function into a serverless
function powered by [`deno`](https://deno.land).


## Usage

```typescript
import { ServerRequest } from "https://deno.land/std@0.52.0/http/server.ts";

export default async (req: ServerRequest) => {
	req.respond({ body: `Hello, from Deno v${Deno.version.deno}!` });
}
```

And define the **vercel-deno** runtime in your `vercel.json` file:

```json
{
	"version": 2,
	"functions": {
		"api/**/*.{j,t}s": { "runtime": "vercel-deno@0.1.3" }
	}
}
```

**Demo:** https://vercel-deno.vercel.app/api/hello
