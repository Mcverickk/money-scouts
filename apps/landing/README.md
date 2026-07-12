# apps/landing — public landing page

Owner: Business (design is ready — implement it here, replacing the placeholder in `public/`).

Plain static site by choice: zero build step, deploys straight to Cloudflare Pages
(the hosting power-up). If the design needs a framework, scaffold it inside this
directory and keep the deploy output pointed at Cloudflare Pages.

Deploy:

```sh
npx wrangler pages deploy apps/landing/public --project-name edge-desk
```
