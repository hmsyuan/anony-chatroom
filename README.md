# anony-chatroom

## Resolve GitHub merge conflicts (`public/index.html`, `server.js`)

If GitHub shows:

- `This branch has conflicts that must be resolved`
- conflicted files: `public/index.html`, `server.js`

you can resolve locally with these commands:

```bash
git fetch origin
git checkout work
git merge origin/main
```

Then open the files and keep the conflict blocks that match this branch's latest behavior (idle heartbeat + emoji below input + optional simple cipher), remove conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`), and run:

```bash
node --check server.js
git add public/index.html server.js
git commit -m "chore: resolve merge conflicts in chat UI and server"
git push origin work
```

### Quick choose-this-branch version (if you want to keep current implementation)

```bash
git checkout --ours public/index.html server.js
git add public/index.html server.js
git commit -m "chore: resolve conflicts by keeping work branch implementation"
git push origin work
```

After push, refresh the PR page and merge again.
