'use strict';
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');

/* The build id is derived from the companion's own source, not maintained by
   hand. A running companion reports the id it computed when it started; the
   launcher computes the id of the files on disk now. Any edit to companion code
   therefore makes the running process look outdated and it gets replaced.

   A hand-written constant was the failure mode this replaces: a companion
   edited but not bumped kept reporting "ready" while its new routes answered
   404, so the launcher never restarted it and the change appeared to do
   nothing. The browser channel stays in the id because switching browsers must
   also invalidate a running companion. */
const SOURCES=['config.cjs','server.cjs','b2b.cjs','operations.cjs','archive.cjs'];
const CHANNEL='chrome';

function sourceFingerprint(dir=__dirname) {
  const hash=crypto.createHash('sha256');
  for (const name of SOURCES) {
    hash.update(name);
    try { hash.update(fs.readFileSync(path.join(dir,name))); }
    catch { hash.update('missing'); } // a missing file is itself a difference
  }
  return hash.digest('hex').slice(0,12);
}
const BUILD=CHANNEL+'-'+sourceFingerprint();

function browserConfig(root) {
  return {channel:CHANNEL,profileDir:path.join(root,'.local','b2b-profile-chrome')};
}
module.exports={BUILD,browserConfig,sourceFingerprint,SOURCES,CHANNEL};
