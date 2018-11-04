/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const execSync = require('child_process').execSync;
const execFileSync = require('child_process').execFileSync;

const newLineRegex = /\r?\n/;

function darwin() {
  const suffixes = ['/Contents/MacOS/Google Chrome Canary', '/Contents/MacOS/Google Chrome'];
  const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework' +
      '/Versions/A/Frameworks/LaunchServices.framework' +
      '/Versions/A/Support/lsregister';

  const installations = [];

  const customChromePath = resolveChromePath();
  if (customChromePath)
    installations.push(customChromePath);

  execSync(
      `${LSREGISTER} -dump` +
      ' | grep -i \'google chrome\\( canary\\)\\?.app$\'' +
      ' | awk \'{$1=""; print $0}\'')
      .toString()
      .split(newLineRegex)
      .forEach(inst => {
        suffixes.forEach(suffix => {
          const execPath = path.join(inst.trim(), suffix);
          if (canAccess(execPath))
            installations.push(execPath);
        });
      });

  // Retains one per line to maintain readability.
  // clang-format off
  const priorities = [
    {regex: new RegExp(`^${process.env.HOME}/Applications/.*Chrome.app`), weight: 50},
    {regex: new RegExp(`^${process.env.HOME}/Applications/.*Chrome Canary.app`), weight: 51},
    {regex: /^\/Applications\/.*Chrome.app/, weight: 100},
    {regex: /^\/Applications\/.*Chrome Canary.app/, weight: 101},
    {regex: /^\/Volumes\/.*Chrome.app/, weight: -2},
    {regex: /^\/Volumes\/.*Chrome Canary.app/, weight: -1},
  ];

  if (process.env.CHROME_PATH)
    priorities.unshift({regex: new RegExp(`${process.env.CHROME_PATH}`), weight: 151});

  // clang-format on
  return sort(installations, priorities);
}

function resolveChromePath() {
  if (canAccess(`${process.env.CHROME_PATH}`))
    return process.env.CHROME_PATH;
  return '';
}

/**
 * Look for linux executables in 3 ways
 * 1. Look into CHROME_PATH env variable
 * 2. Look into the directories where .desktop are saved on gnome based distro's
 * 3. Look for google-chrome-stable & google-chrome executables by using the which command
 */
function linux() {
  let installations = [];

  // 1. Look into CHROME_PATH env variable
  const customChromePath = resolveChromePath();
  if (customChromePath)
    installations.push(customChromePath);

  // 2. Look into the directories where .desktop are saved on gnome based distro's
  const desktopInstallationFolders = [
    path.join(require('os').homedir(), '.local/share/applications/'),
    '/usr/share/applications/',
  ];
  desktopInstallationFolders.forEach(folder => {
    installations = installations.concat(findChromeExecutables(folder));
  });

  // Look for google-chrome(-stable) & chromium(-browser) executables by using the which command
  const executables = [
    'google-chrome-stable',
    'google-chrome',
    'chromium-browser',
    'chromium',
  ];
  executables.forEach(executable => {
    try {
      const chromePath =
          execFileSync('which', [executable], {stdio: 'pipe'}).toString().split(newLineRegex)[0];
      if (canAccess(chromePath))
        installations.push(chromePath);
    } catch (e) {
      // Not installed.
    }
  });

  if (!installations.length)
    throw new Error('The environment variable CHROME_PATH must be set to executable of a build of Chromium version 54.0 or later.');

  const priorities = [
    {regex: /chrome-wrapper$/, weight: 51},
    {regex: /google-chrome-stable$/, weight: 50},
    {regex: /google-chrome$/, weight: 49},
    {regex: /chromium-browser$/, weight: 48},
    {regex: /chromium$/, weight: 47},
  ];

  if (process.env.CHROME_PATH)
    priorities.unshift({regex: new RegExp(`${process.env.CHROME_PATH}`), weight: 101});

  return sort(uniq(installations.filter(Boolean)), priorities);
}

function win32() {
  const installations = [];
  const suffixes = [
    `${path.sep}Google${path.sep}Chrome SxS${path.sep}Application${path.sep}chrome.exe`,
    `${path.sep}Google${path.sep}Chrome${path.sep}Application${path.sep}chrome.exe`
  ];
  const prefixes = [
    process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']
  ].filter(Boolean);

  const customChromePath = resolveChromePath();
  if (customChromePath)
    installations.push(customChromePath);

  prefixes.forEach(prefix => suffixes.forEach(suffix => {
    const chromePath = path.join(prefix, suffix);
    if (canAccess(chromePath))
      installations.push(chromePath);
  }));
  return installations;
}

function sort(installations, priorities) {
  const defaultPriority = 10;
  return installations
      // assign priorities
      .map(inst => {
        for (const pair of priorities) {
          if (pair.regex.test(inst))
            return {path: inst, weight: pair.weight};
        }
        return {path: inst, weight: defaultPriority};
      })
      // sort based on priorities
      .sort((a, b) => (b.weight - a.weight))
      // remove priority flag
      .map(pair => pair.path);
}

function canAccess(file) {
  if (!file)
    return false;

  try {
    fs.accessSync(file);
    return true;
  } catch (e) {
    return false;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function findChromeExecutables(folder) {
  const argumentsRegex = /(^[^ ]+).*/; // Take everything up to the first space
  const chromeExecRegex = '^Exec=\/.*\/(google-chrome|chrome|chromium)-.*';

  const installations = [];
  if (canAccess(folder)) {
    // Output of the grep & print looks like:
    //    /opt/google/chrome/google-chrome --profile-directory
    //    /home/user/Downloads/chrome-linux/chrome-wrapper %U
    let execPaths;

    // Some systems do not support grep -R so fallback to -r.
    // See https://github.com/GoogleChrome/chrome-launcher/issues/46 for more context.
    try {
      execPaths = execSync(`grep -ER "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
    } catch (e) {
      execPaths = execSync(`grep -Er "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
    }

    execPaths = execPaths.toString()
        .split(newLineRegex)
        .map(execPath => execPath.replace(argumentsRegex, '$1'));

    execPaths.forEach(execPath => canAccess(execPath) && installations.push(execPath));
  }

  return installations;
}

function installations() {
  if (process.platform === 'linux')
    return linux();
  if (process.platform === 'win32')
    return win32();
  if (process.platform === 'darwin')
    return darwin();
  return [];
}

module.exports = installations;
