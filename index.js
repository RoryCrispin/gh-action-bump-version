// test
const { execSync, spawn } = require('child_process');
const { existsSync } = require('fs');
const { EOL } = require('os');
const path = require('path');

// Change working directory if user defined PACKAGEJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
} else if (process.env.INPUT_PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.INPUT_PACKAGEJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

console.log('process.env.GITHUB_WORKSPACE:', process.env.GITHUB_WORKSPACE);
const workspace = process.env.GITHUB_WORKSPACE;

(async () => {
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  const tagSuffix = process.env['INPUT_TAG-SUFFIX'] || '';
  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  const checkLastCommitOnly = process.env['INPUT_CHECK-LAST-COMMIT-ONLY'] || 'false';

  if (!event.commits && !process.env['INPUT_VERSION-TYPE']) {
    console.log("Couldn't find any commits in this event, incrementing patch version if no explicit version-type given...");
  }

  const allowedTypes = ['major', 'minor', 'patch', 'premajor', 'preminor', 'prepatch', 'prerelease'];
  if (process.env['INPUT_VERSION-TYPE'] && !allowedTypes.includes(process.env['INPUT_VERSION-TYPE'])) {
    exitFailure('Invalid version type provided.');
    return;
  }

  let messages = [];
  if (checkLastCommitOnly === 'true') {
    console.log('Only checking the last commit message for bump policy...');
    const commit = event.commits && event.commits.length > 0 ? event.commits[event.commits.length - 1] : (event.head_commit || null);
    messages = commit ? [commit.message + (commit.body ? '\n' + commit.body : '')] : [];
  } else {
    messages = event.commits ? event.commits.map((commit) => commit.message + (commit.body ? '\n' + commit.body : '')) : [];
    if (messages.length === 0 && event.head_commit) { // Handle case where event.commits is empty but head_commit exists (e.g. manual trigger)
        messages = [event.head_commit.message + (event.head_commit.body ? '\n' + event.head_commit.body : '')];
    }
  }
  console.log('Commit messages for bump policy check:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(
    commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+${tagSuffix}`),
    'ig',
  );

  let isVersionBump = false;
  if (bumpPolicy === 'all') {
    isVersionBump = messages.some((message) => commitMessageRegex.test(message));
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Bump policy set to ignore. Skipping check for previous version bumps in commit messages.');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}. Defaulting to 'all'.`);
    isVersionBump = messages.some((message) => commitMessageRegex.test(message));
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because a previous version bump commit was found according to the bump policy.');
    return;
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWords = (process.env['INPUT_MAJOR-WORDING'] || '').split(',').map(w => w.trim()).filter(w => w);
  const minorWords = (process.env['INPUT_MINOR-WORDING'] || '').split(',').map(w => w.trim()).filter(w => w);
  const patchWords = process.env['INPUT_PATCH-WORDING'] ? (process.env['INPUT_PATCH-WORDING'] || '').split(',').map(w => w.trim()).filter(w => w) : null;
  const preReleaseWords = process.env['INPUT_RC-WORDING'] ? (process.env['INPUT_RC-WORDING'] || '').split(',').map(w => w.trim()).filter(w => w) : null;

  console.log('Configured versioning words:', { majorWords, minorWords, patchWords, preReleaseWords });

  let version = process.env.INPUT_DEFAULT || 'patch'; // Default to patch if nothing else is specified
  let foundWord = null;
  let preid = process.env.INPUT_PREID; // e.g., 'rc', 'beta'

  // Determine version bump type
  if (process.env['INPUT_VERSION-TYPE']) {
    version = process.env['INPUT_VERSION-TYPE'];
  } else if (messages.some(msg => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(msg) || majorWords.some(word => msg.includes(word)))) {
    version = 'major';
  } else if (messages.some(msg => minorWords.some(word => msg.includes(word)))) {
    version = 'minor';
  } else if (patchWords && messages.some(msg => patchWords.some(word => msg.includes(word)))) {
    version = 'patch';
  } else if (preReleaseWords && messages.some(msg => preReleaseWords.some(word => {
    if (msg.includes(word)) {
      foundWord = word; return true;
    } return false;
  }))) {
    if (foundWord) { // Extract preid from found word like 'rc-alpha' -> 'alpha'
        const parts = foundWord.split('-');
        if (parts.length > 1) preid = parts.slice(1).join('-'); // Allows for preids like 'rc-1' or 'beta-build'
    }
    version = 'prerelease';
  }

  console.log('Version type after commit message analysis:', version);

  if (version === 'prerelease' && preReleaseWords && !foundWord && !process.env['INPUT_VERSION-TYPE']) {
    // Case: default is prerelease, rc-wording is set, but no rc-words found in commits, and no explicit version-type.
    // This means we should not bump if the trigger wasn't an explicit prerelease keyword.
    // If INPUT_DEFAULT was 'prerelease', we honour it only if preid is also set.
    if (process.env.INPUT_DEFAULT === 'prerelease' && !preid) {
        version = null; // Don't bump if default is prerelease without a preid and no keywords match
    } else if (process.env.INPUT_DEFAULT !== 'prerelease') {
        version = null;
    }
  }

  if (['prerelease', 'prepatch', 'preminor', 'premajor'].includes(version) && preid) {
    version = `${version} --preid=${preid}`;
  }

  console.log('Final version action string:', version);

  if (!version) {
    exitSuccess('No version keywords found or prerequisites met, skipping bump.');
    return;
  }

  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
    return;
  }

  let finalNewVersion = ''; // To store the version for the success message

  // GIT logic
  try {
    let currentBranch;
    if (process.env.GITHUB_HEAD_REF) { // Typically for pull requests
      currentBranch = process.env.GITHUB_HEAD_REF;
    } else { // Typically for push events
      const ref = process.env.GITHUB_REF;
      if (ref && ref.startsWith('refs/heads/')) {
        currentBranch = ref.substring('refs/heads/'.length);
      } else if (ref && ref.startsWith('refs/tags/')) {
        // If triggered by a tag, you might want to push to a default branch or a specified target-branch.
        // This script focuses on bumping version on a branch.
        // INPUT_TARGET-BRANCH should be used if triggered by a tag and wanting to commit to a branch.
        console.warn(`Workflow triggered by tag ${ref}. Target branch must be specified via INPUT_TARGET-BRANCH if a branch commit is desired.`);
        currentBranch = undefined; // Requires INPUT_TARGET-BRANCH
      } else {
        currentBranch = undefined;
      }
    }

    if (process.env['INPUT_TARGET-BRANCH']) { // Override if specific target branch is set
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('Target branch for operations:', currentBranch);

    if (!currentBranch) {
      exitFailure('No target branch could be determined. For tag-triggered workflows, ensure INPUT_TARGET-BRANCH is set.');
      return;
    }

    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', ['config', 'user.email', `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`]);

    console.log(`Workspaceing latest of branch: ${currentBranch} from origin`);
    try {
      await runInWorkspace('git', ['fetch', 'origin', `${currentBranch}:${currentBranch}`, '--depth=1']);
    } catch (fetchError) {
      console.warn(`Failed to fetch directly into local branch ${currentBranch}. This can happen if the local branch doesn't exist or has diverged significantly. Attempting general fetch. Error: ${fetchError}`);
      await runInWorkspace('git', ['fetch', 'origin', currentBranch, '--depth=1']);
    }

    console.log(`Checking out branch: ${currentBranch}`);
    await runInWorkspace('git', ['checkout', currentBranch]);

    const pkg = getPackageJson(); // Get package.json *after* checking out the correct branch
    const currentVersionOnBranch = pkg.version.toString();

    await runInWorkspace('npm', ['config', 'set', 'fund', 'false', '-ws=false', '-iwr']); // -ws=false -iwr for npm workspaces issues
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', currentVersionOnBranch]);
    console.log(`Current version on branch ${currentBranch} is: ${currentVersionOnBranch}. Bumping with: ${version}`);

    const newVersionOutput = execSync(`npm version --git-tag-version=false ${version} --silent`, { cwd: workspace }).toString();
    let newSemVer = parseNpmVersionOutput(newVersionOutput);
    console.log('Version determined by npm:', newSemVer);

    finalNewVersion = `${tagPrefix}${newSemVer}${tagSuffix}`;
    console.log(`New version with prefix/suffix: ${finalNewVersion}`);

    try {
      await runInWorkspace('sh', ['-c', `echo "newTag=${finalNewVersion}" >> $GITHUB_OUTPUT`]);
      await runInWorkspace('sh', ['-c', `echo "newVersion=${newSemVer}" >> $GITHUB_OUTPUT`]); // Output the pure semver too
    } catch { // Fallback for older runners
      console.log(`::set-output name=newTag::${finalNewVersion}`);
      console.log(`::set-output name=newVersion::${newSemVer}`);
    }

    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      console.log('Adding changes to git...');
      await runInWorkspace('git', ['add', 'package.json']);
      if (existsSync(path.join(workspace, 'package-lock.json'))) {
        await runInWorkspace('git', ['add', 'package-lock.json']);
      }
      if (existsSync(path.join(workspace, 'npm-shrinkwrap.json'))) {
        await runInWorkspace('git', ['add', 'npm-shrinkwrap.json']);
      }
      // Add other files here if your npm version scripts modify them (e.g., changelogs)

      const commitCmdArgs = ['commit', '-m', commitMessage.replace(/{{version}}/g, finalNewVersion)];
      if (process.env['INPUT_COMMIT-NO-VERIFY'] === 'true') {
        commitCmdArgs.push('--no-verify');
      }
      console.log(`Committing version bump to ${finalNewVersion}`);
      await runInWorkspace('git', commitCmdArgs);
    } else {
      console.log('Skipping commit.');
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@${process.env['INPUT_CUSTOM-GIT-DOMAIN'] || 'github.com'}/${process.env.GITHUB_REPOSITORY}.git`;

    if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
      console.log(`Pushing ${currentBranch} to remote`);
      await runInWorkspace('git', ['push', remoteRepo, currentBranch]);

      if (process.env['INPUT_SKIP-TAG'] !== 'true' && process.env['INPUT_SKIP-COMMIT'] !== 'true') { // Can only tag if a commit was made
        console.log(`Tagging version ${finalNewVersion}`);
        await runInWorkspace('git', ['tag', finalNewVersion]);
        console.log(`Pushing tag ${finalNewVersion} to remote`);
        await runInWorkspace('git', ['push', remoteRepo, finalNewVersion]);
      } else if (process.env['INPUT_SKIP-TAG'] !== 'true' && process.env['INPUT_SKIP-COMMIT'] === 'true') {
          console.log('Skipping tag because commit was skipped.');
      } else {
        console.log('Skipping tag.');
      }
    } else {
      console.log('Skipping push (and therefore tag push).');
    }

  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess(`Version bumped to ${finalNewVersion || 'specified type'}!`);
})();

function getPackageJson() {
  const packageJSONFileName = process.env.PACKAGE_FILENAME || 'package.json';
  const pathToPackage = path.join(workspace, packageJSONFileName);
  if (!existsSync(pathToPackage)) {
    throw new Error(`${packageJSONFileName} could not be found in your project's root: ${pathToPackage}`);
  }
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function parseNpmVersionOutput(output) {
  console.log('[parseNpmVersionOutput] Raw output:', output);
  const lines = output.trim().split(EOL);
  // npm version output can be just 'v1.2.3' or multiple lines in a workspace like 'package-a: v1.2.3\npackage-b: v1.2.4'
  // Or sometimes it just outputs the version like '1.2.3'
  // We want the line that is the new version.
  let newVersionStr = lines[lines.length - 1]; // Default to the last line

  // Try to find a line that explicitly looks like a version string, preferring 'vX.Y.Z'
  const versionLookingLine = lines.find(line => /^\s*v?\d+\.\d+\.\d+/.test(line.trim()));
  if (versionLookingLine) {
    newVersionStr = versionLookingLine.trim();
  }
  
  // If it's a workspace output like "package-name: v1.2.3", extract the version part
  const workspaceMatch = newVersionStr.match(/:\s*(v?\d+\.\d+\.\d+.*)$/);
  if (workspaceMatch && workspaceMatch[1]) {
      newVersionStr = workspaceMatch[1];
  }

  console.log('[parseNpmVersionOutput] Selected version line:', newVersionStr);
  const version = newVersionStr.replace(/^v/, ''); // Remove leading 'v'
  return version;
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    console.log('runInWorkspace | command:', command, 'args:', args.join(' '));
    const child = spawn(command, args, { cwd: workspace, shell: false }); // shell: false is safer
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data); // Stream stdout
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data); // Stream stderr
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command '${command} ${args.join(' ')}' exited with code ${code}:\n${stderr.trim()}`));
      }
    });
  });
}
