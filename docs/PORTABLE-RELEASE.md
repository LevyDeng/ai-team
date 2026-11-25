# Windows portable releases

Build on Windows x64 from the commit you intend to release. Set the same, higher version in `desktop/package.json` and `desktop/package-lock.json` and commit it before building.

```powershell
Set-Location desktop
npm ci
npm run pack:windows
```

The pack command uses the committed tree at `HEAD` and writes `.runtime/release/ai-team-<version>-win-x64.zip`. Test the ZIP after extracting it. Attach the ZIP to a stable GitHub Release and mark that release as latest. The built-in updater uses GitHub's asset size and SHA-256 digest. It compares the version in the asset filename with the running app version.

Users extract the ZIP and run `ai-team.exe`. Releases with the updater can install subsequent releases from Settings → Update Center. The updater retains the existing portable directory, including `resources/app/.runtime` and `resources/app/.env`, so paths stored in chat history still resolve. It saves the workspace database before validating the new app's startup. A failed startup restores the old program and database.

For a first upgrade from a ZIP without the updater, close the app, back up the existing folder, and extract the new ZIP. To keep existing absolute paths, overlay the contents of the new versioned folder onto the original portable folder and keep `resources/app/.runtime` and `resources/app/.env` there.

If the update is interrupted and neither version starts, run `Recover update.cmd` inside the active job folder under `.ai-team-update` in the portable directory.
