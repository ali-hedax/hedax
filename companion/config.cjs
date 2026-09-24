'use strict';
const path=require('node:path');
const BUILD='chrome-2026-09-24';
function browserConfig(root) {
  return {channel:'chrome',profileDir:path.join(root,'.local','b2b-profile-chrome')};
}
module.exports={BUILD,browserConfig};
