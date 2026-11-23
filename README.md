# Big Mama Burgers n' Fries

Next.js static export of the Big Mama website.

## Run locally

Install Node.js and npm, then run `npm ci` and `npm run dev`.
Run `npm run build` to create `out/`, then `npm run preview` to serve it.
Set `PORT` to change the preview port (default: 3000).
Set `NEXT_PUBLIC_BASE_PATH` before building when hosting under a URL prefix.
The existing site loads Leaflet from unpkg at runtime.
