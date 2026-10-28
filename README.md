# Auderghem slot watcher

Checks the Auderghem commune booking site for **Première inscription – UE** and pushes a phone notification when a slot earlier than `BEFORE` (default 24/11/2026) appears. It replays the click-through from a fresh session each run, so no cookies or manual steps are needed. It only reads availability and never books.

## 1. Notifications (ntfy, free, no account)
1. Install the **ntfy** app (iOS/Android).
2. Subscribe to a hard-to-guess topic, e.g. `char-auderghem-k39fz2`. Anyone who knows the name can read it, so make it random.
3. Test locally: `NTFY_TOPIC=char-auderghem-k39fz2 node check-slots.mjs --test`

## 2a. Run on GitHub Actions (nothing to host)
1. Create a repo containing `check-slots.mjs` and `.github/workflows/watch.yml`.
2. Settings → Secrets and variables → Actions → New secret `NTFY_TOPIC`.
3. Actions tab → "Auderghem slot watcher" → **Run workflow** once to confirm it's green.

Make it a **public** repo for unlimited free minutes; there's nothing sensitive in it because the topic lives in a secret. A private repo also works: 15-minute runs during the day stay within the 2,000 free minutes.

## 2b. Or run on a VM / always-on machine (more reliable timing)
```
*/10 7-21 * * * cd ~/slot-watcher && NTFY_TOPIC=char-auderghem-k39fz2 /usr/bin/node check-slots.mjs >> watcher.log 2>&1
```
(Set the VM to the Europe/Brussels timezone, or adjust the hours.)

## Behaviour
- Alerts once per new early slot. If a slot disappears and comes back, it alerts again.
- If the site changes or is down, you get at most one low-priority "error" push every 12 hours.
- Change `BEFORE` to move the threshold, for example once you've grabbed an earlier slot.
- Please keep the interval at 10 minutes or more. It's a small commune server.
