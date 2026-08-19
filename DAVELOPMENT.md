# Development workflow

Once migration registers the local package path, Pi loads directly from:

```text
/Users/spotted/projects/pi-agent-wave/extensions/pi-agent-wave
```

The package is not copied, so normal development does not require reinstalling it.

## Normal loop

1. Update the PRD first for behavior or scope changes:

   ```text
   tasks/prd-package-delegate-graph.md
   ```

2. Edit code under:

   ```text
   extensions/pi-agent-wave/
   ```

3. Run the focused test:

   ```bash
   bun test extensions/pi-agent-wave/test/<relevant-file>.test.ts
   ```

4. Typecheck:

   ```bash
   cd extensions/pi-agent-wave
   npm run typecheck
   cd ../..
   ```

5. In the running Pi session, reload the package:

   ```text
   /reload
   ```

   Then exercise `/delegate`, `/graph`, `/route`, or `/failover`. Restart Pi instead when changing dependencies or `package.json`.

6. Before considering the change complete:

   ```bash
   node --experimental-strip-types --test extensions/pi-agent-wave/test/*.test.ts

   cd extensions/pi-agent-wave
   npm pack --dry-run --json --ignore-scripts
   npm publish --dry-run --json --ignore-scripts
   cd ../..

   git diff --check
   ```

## Dependency changes

After modifying `package.json`:

```bash
cd extensions/pi-agent-wave
npm install --ignore-scripts --no-audit --no-fund
npm run typecheck
```

Commit `package-lock.json`, but never `node_modules/`.

## Important

- Never edit or recreate the removed loose extensions.
- Keep the repository at the same absolute path; Pi settings reference it directly.
- Keep the migration manifest. It is needed only to restore the old loose installation.
- Do not run a real migration, publish, commit, or push through the agent unless explicitly authorized.
