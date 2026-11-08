# Production deployment

BAG HEIST is a client-rendered, dynamic NEAR application. Hosting serves versioned assets; live state, authorization, settlement, and token accounting come from the selected NEAR contract and wallet.

## GitHub Pages

The `Deploy GitHub Pages` workflow builds with `VITE_BASE_PATH=/bag-heist/` and publishes `dist/`. Repository Pages must use **GitHub Actions** as its source. The expected public URL is:

`https://eshaanvgupta.github.io/bag-heist/`

Set repository variable `VITE_NEAR_CONTRACT_ID` after a testnet deployment. Leaving it blank is safe: practice and evidence modes work, while Live testnet requires the user to enter a contract before connecting.

## Container

```bash
docker build -f deploy/Dockerfile -t bag-heist:1.0.0 .
docker run --rm -p 8080:8080 bag-heist:1.0.0
curl --fail http://127.0.0.1:8080/healthz
```

The image builds with the pinned Node/pnpm toolchain, runs as an unprivileged nginx user, includes SPA routing, immutable caching for hashed assets, a no-store rule for evidence JSON, and security headers.

## Runtime operations

- Deploy the exact source commit and record the generated asset/WASM hashes.
- Use HTTPS; wallet redirects and Web Crypto require a secure browser context outside localhost.
- Monitor availability of the host and selected NEAR RPC independently.
- Publish testnet evidence only after `pnpm verify:testnet` confirms every receipt and code hash.
- Treat full-access contract-account keys as production credentials; keep them outside the repository and document the actual key policy.
