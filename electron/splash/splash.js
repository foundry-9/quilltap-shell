// @ts-check
/// <reference path="../types.ts" />

const statusEl = document.getElementById('status');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const detailEl = document.getElementById('detail');
const firstRunNote = document.getElementById('firstRunNote');
const loadingContainer = document.getElementById('loading');
const errorContainer = document.getElementById('errorContainer');
const errorMessage = document.getElementById('errorMessage');
const retryBtn = document.getElementById('retryBtn');
const quitBtn = document.getElementById('quitBtn');
const logo = document.getElementById('logo');

// Directory chooser elements
const directoryContainer = document.getElementById('directoryContainer');
const directoryList = document.getElementById('directoryList');
const addDirBtn = document.getElementById('addDirBtn');
const startBtn = document.getElementById('startBtn');
const chooserQuitBtn = document.getElementById('chooserQuitBtn');
const autoStartCheckbox = document.getElementById('autoStartCheckbox');
const changeDirLink = document.getElementById('changeDirLink');

// Runtime mode elements
const runtimeDockerBtn = document.getElementById('runtimeDocker');
const runtimeVMBtn = document.getElementById('runtimeVM');
const runtimeEmbeddedBtn = document.getElementById('runtimeEmbedded');
const vmLabelEl = document.getElementById('vmLabel');

// Version selector elements
const versionSection = document.getElementById('versionSection');
const versionSelect = document.getElementById('versionSelect');
const prereleaseCheckbox = document.getElementById('prereleaseCheckbox');
const prereleaseLabel = document.getElementById('prereleaseLabel');

// Upgrade banner elements
const upgradeBanner = document.getElementById('upgradeBanner');
const upgradeBannerText = document.getElementById('upgradeBannerText');
const upgradeAcceptBtn = document.getElementById('upgradeAcceptBtn');
const upgradeDeclineBtn = document.getElementById('upgradeDeclineBtn');

/** Pending upgrade version (set when banner is shown) */
var pendingUpgradeVersion = '';

// Rename elements
const renameOverlay = document.getElementById('renameOverlay');
const renameInput = document.getElementById('renameInput');
const renameDialogPath = document.getElementById('renameDialogPath');
const renameSaveBtn = document.getElementById('renameSaveBtn');
const renameCancelBtn = document.getElementById('renameCancelBtn');

// Delete confirmation elements
const deleteOverlay = document.getElementById('deleteOverlay');
const deleteDialogPath = document.getElementById('deleteDialogPath');
const deleteConfigOnlyBtn = document.getElementById('deleteConfigOnlyBtn');
const deleteConfigAndDataBtn = document.getElementById('deleteConfigAndDataBtn');
const deleteCancelBtn = document.getElementById('deleteCancelBtn');

// VM erase confirmation elements
const vmEraseOverlay = document.getElementById('vmEraseOverlay');
const vmEraseDialogPath = document.getElementById('vmEraseDialogPath');
const vmEraseConfirmBtn = document.getElementById('vmEraseConfirmBtn');
const vmEraseCancelBtn = document.getElementById('vmEraseCancelBtn');

/** Currently selected directory in the chooser */
var selectedDir = '';

/** Current sizes data (may arrive after initial directory list) */
var currentSizes = {};

/** Minimum server versions per directory path (from data/quilltap.dbkey) */
var currentMinServerVersions = {};

/** Current runtime mode */
var currentRuntimeMode = 'vm';

/** Last known available versions (preserved across runtime mode toggles) */
var lastAvailableVersions = [];

/** Last known server version setting */
var lastServerVersion = 'latest';

/** Whether to show pre-release versions */
var showPrerelease = false;

/** Directory pending deletion (for the confirmation dialog) */
var pendingDeleteDir = '';

/** Directory pending rename (path of the directory being renamed) */
var pendingRenameDir = '';

/** Directory pending VM erase */
var pendingVMEraseDir = '';

/** Phase descriptions shown to the user */
var phaseMessages = {
  'choose-directory': 'Choose data directory',
  'initializing': 'Initializing...',
  'downloading': 'Downloading system image...',
  'creating-vm': 'Creating virtual machine...',
  'updating-vm': 'Updating Quilltap to latest build...',
  'starting-vm': 'Starting virtual machine...',
  'pulling-image': 'Pulling Docker image...',
  'starting-container': 'Starting Docker container...',
  'starting-server': 'Starting server...',
  'waiting-health': 'Waiting for server...',
  'ready': 'Ready!',
  'error': 'Something went wrong',
};

/**
 * Format a byte count into a human-readable string.
 * Duplicated from disk-utils since splash.js has no Node access.
 */
function formatBytes(bytes) {
  if (bytes < 0) return '';
  if (bytes === 0) return '0 B';

  var units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var k = 1024;
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  var value = bytes / Math.pow(k, i);

  return value.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

/**
 * Build a size summary string for a directory.
 * Returns empty string if no size data available.
 */
function formatSizeInfo(sizeInfo) {
  if (!sizeInfo) return '';

  var parts = [];
  if (sizeInfo.dataSize >= 0) {
    parts.push('Data: ' + formatBytes(sizeInfo.dataSize));
  }
  if (sizeInfo.vmSize >= 0) {
    parts.push('VM: ' + formatBytes(sizeInfo.vmSize));
  } else {
    parts.push('No VM');
  }

  return parts.join(' \u2022 '); // bullet separator
}

/** Show one UI section and hide the others */
function showSection(section) {
  loadingContainer.classList.add('hidden');
  errorContainer.classList.remove('visible');
  directoryContainer.classList.remove('visible');

  if (section === 'loading') {
    loadingContainer.classList.remove('hidden');
  } else if (section === 'error') {
    errorContainer.classList.add('visible');
  } else if (section === 'directory') {
    directoryContainer.classList.add('visible');
  }
}

/** Update the runtime mode button visual state */
function updateRuntimeButtons() {
  runtimeDockerBtn.classList.remove('selected');
  runtimeVMBtn.classList.remove('selected');
  runtimeEmbeddedBtn.classList.remove('selected');

  if (currentRuntimeMode === 'docker') {
    runtimeDockerBtn.classList.add('selected');
  } else if (currentRuntimeMode === 'embedded') {
    runtimeEmbeddedBtn.classList.add('selected');
  } else {
    runtimeVMBtn.classList.add('selected');
  }
}

/** Update the prerelease checkbox visual state */
function updatePrereleaseCheckbox() {
  prereleaseCheckbox.checked = showPrerelease;
  if (showPrerelease) {
    prereleaseLabel.classList.add('active');
  } else {
    prereleaseLabel.classList.remove('active');
  }
}

/** Update the version selector visibility and contents */
function updateVersionSelector(versions, serverVersion) {
  // Show version selector for all runtime modes
  versionSection.style.display = '';

  // Preserve state across calls that don't provide new data
  if (versions && versions.length > 0) lastAvailableVersions = versions;
  if (serverVersion) lastServerVersion = serverVersion;
  versions = lastAvailableVersions;

  // Remember current selection
  var currentValue = lastServerVersion || versionSelect.value || 'latest';

  // Rebuild options
  versionSelect.innerHTML = '';

  var latestOpt = document.createElement('option');
  latestOpt.value = 'latest';
  latestOpt.textContent = 'Latest Release';
  versionSelect.appendChild(latestOpt);

  // Only show "Latest Dev" when prerelease is enabled
  if (showPrerelease) {
    var latestDevOpt = document.createElement('option');
    latestDevOpt.value = 'latest-dev';
    latestDevOpt.textContent = 'Latest Dev';
    versionSelect.appendChild(latestDevOpt);
  }

  if (versions && versions.length > 0) {
    var stableGroup = document.createElement('optgroup');
    stableGroup.label = 'Stable Releases';
    var devGroup = document.createElement('optgroup');
    devGroup.label = 'Dev Releases';

    var hasStable = false;
    var hasDev = false;

    versions.forEach(function(v) {
      var opt = document.createElement('option');
      opt.value = v.tag;
      opt.textContent = v.label;
      if (v.prerelease) {
        if (showPrerelease) {
          devGroup.appendChild(opt);
          hasDev = true;
        }
      } else {
        stableGroup.appendChild(opt);
        hasStable = true;
      }
    });

    if (hasStable) versionSelect.appendChild(stableGroup);
    if (hasDev) versionSelect.appendChild(devGroup);
  }

  // Restore selection — if the saved version isn't in the list, add it
  var found = false;
  for (var i = 0; i < versionSelect.options.length; i++) {
    if (versionSelect.options[i].value === currentValue) {
      found = true;
      break;
    }
  }
  if (!found && currentValue !== 'latest' && currentValue !== 'latest-dev') {
    var customOpt = document.createElement('option');
    customOpt.value = currentValue;
    customOpt.textContent = currentValue + ' (saved)';
    versionSelect.appendChild(customOpt);
  }

  // If prerelease was just unchecked and the current value is a dev selection,
  // fall back to 'latest'
  if (!showPrerelease && !found && (currentValue === 'latest-dev')) {
    currentValue = 'latest';
    lastServerVersion = currentValue;
    window.quilltap.setServerVersion(currentValue);
  }

  versionSelect.value = currentValue;
}

/** Show the delete confirmation dialog */
function showDeleteConfirmation(dir) {
  pendingDeleteDir = dir;
  deleteDialogPath.textContent = dir;
  deleteOverlay.classList.add('visible');
}

/** Hide the delete confirmation dialog */
function hideDeleteConfirmation() {
  pendingDeleteDir = '';
  deleteOverlay.classList.remove('visible');
}

/** Show the VM erase confirmation dialog */
function showVMEraseConfirmation(dir) {
  pendingVMEraseDir = dir;
  vmEraseDialogPath.textContent = dir;
  vmEraseOverlay.classList.add('visible');
}

/** Hide the VM erase confirmation dialog */
function hideVMEraseConfirmation() {
  pendingVMEraseDir = '';
  vmEraseOverlay.classList.remove('visible');
}

/** Show the rename dialog for a directory */
function showRenameDialog(dir) {
  pendingRenameDir = dir.path;
  renameInput.value = dir.name;
  renameDialogPath.textContent = dir.path;
  renameOverlay.classList.add('visible');
  renameInput.focus();
  renameInput.select();
}

/** Hide the rename dialog */
function hideRenameDialog() {
  pendingRenameDir = '';
  renameOverlay.classList.remove('visible');
}

/** Render the directory list from the given info */
function renderDirectoryList(dirs, lastUsed, sizes, minServerVersions) {
  directoryList.innerHTML = '';
  selectedDir = lastUsed || (dirs.length > 0 ? dirs[0].path : '');

  dirs.forEach(function(dir) {
    var dirPath = dir.path;
    var dirName = dir.name;

    var item = document.createElement('div');
    item.className = 'directory-item' + (dirPath === selectedDir ? ' selected' : '');

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'dataDir';
    radio.checked = dirPath === selectedDir;

    var infoWrap = document.createElement('div');
    infoWrap.className = 'directory-item-info';

    var nameRow = document.createElement('div');
    nameRow.className = 'directory-item-name-row';

    var nameLabel = document.createElement('span');
    nameLabel.className = 'directory-item-name';
    nameLabel.textContent = dirName;
    nameLabel.title = dirName;
    nameRow.appendChild(nameLabel);

    // Show minServerVersion alongside the name if present
    var minVer = minServerVersions && minServerVersions[dirPath];
    if (minVer) {
      var minVerLabel = document.createElement('span');
      minVerLabel.className = 'directory-item-min-version';
      minVerLabel.textContent = '\u2265 ' + minVer;
      minVerLabel.title = 'Minimum server version: ' + minVer;
      nameRow.appendChild(minVerLabel);
    }

    infoWrap.appendChild(nameRow);

    var pathLabel = document.createElement('span');
    pathLabel.className = 'directory-item-path';
    pathLabel.textContent = dirPath;
    pathLabel.title = dirPath;
    infoWrap.appendChild(pathLabel);

    // Add size info if available
    var sizeText = formatSizeInfo(sizes && sizes[dirPath]);
    if (sizeText) {
      var sizeLabel = document.createElement('span');
      sizeLabel.className = 'directory-item-sizes';
      sizeLabel.textContent = sizeText;
      infoWrap.appendChild(sizeLabel);
    }

    item.appendChild(radio);
    item.appendChild(infoWrap);

    // Edit (rename) button
    var editBtn = document.createElement('button');
    editBtn.className = 'directory-item-edit';
    editBtn.textContent = '\u270E'; // pencil icon
    editBtn.title = 'Rename...';
    editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showRenameDialog(dir);
    });
    item.appendChild(editBtn);

    // VM erase button (only when VM mode is active and a VM exists)
    var sizeInfo = sizes && sizes[dirPath];
    if (currentRuntimeMode === 'vm' && sizeInfo && sizeInfo.vmSize >= 0) {
      var vmEraseBtn = document.createElement('button');
      vmEraseBtn.className = 'directory-item-vm-erase';
      vmEraseBtn.textContent = '\u21BB'; // clockwise open circle arrow (reset)
      vmEraseBtn.title = 'Erase VM...';
      vmEraseBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        showVMEraseConfirmation(dirPath);
      });
      item.appendChild(vmEraseBtn);
    }

    // Delete button
    var removeBtn = document.createElement('button');
    removeBtn.className = 'directory-item-remove';
    removeBtn.textContent = '\u00d7'; // multiplication sign (x)
    removeBtn.title = 'Delete...';
    removeBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showDeleteConfirmation(dirPath);
    });
    item.appendChild(removeBtn);

    // Click to select
    item.addEventListener('click', function() {
      selectedDir = dirPath;
      // Update visual selection
      directoryList.querySelectorAll('.directory-item').forEach(function(el) {
        el.classList.remove('selected');
        el.querySelector('input[type="radio"]').checked = false;
      });
      item.classList.add('selected');
      radio.checked = true;
    });

    directoryList.appendChild(item);
  });
}

/** Handle splash update from main process */
window.quilltap.onUpdate(function(data) {
  if (data.phase === 'choose-directory') {
    // Show directory chooser
    showSection('directory');
    logo.classList.remove('pulse');
    changeDirLink.classList.remove('visible');
    return;
  }

  // Show loading, hide error and directory chooser
  showSection('loading');
  logo.classList.add('pulse');

  // Update status message
  statusEl.textContent = data.message || phaseMessages[data.phase] || data.phase;

  // Show the "change directory" button during startup phases (hide once ready)
  if (data.phase !== 'ready') {
    changeDirLink.classList.add('visible');
  } else {
    changeDirLink.classList.remove('visible');
  }

  // Show progress bar for download and Docker phases
  if (data.phase === 'downloading' && typeof data.progress === 'number') {
    progressContainer.classList.add('visible');
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = data.progress + '%';
    firstRunNote.classList.add('visible');
  } else if (
    data.phase === 'creating-vm' || data.phase === 'updating-vm' || data.phase === 'starting-vm' ||
    data.phase === 'pulling-image' || data.phase === 'starting-container' || data.phase === 'starting-server'
  ) {
    progressContainer.classList.add('visible');
    progressBar.classList.add('indeterminate');
    progressBar.style.width = '';
    firstRunNote.classList.add('visible');
  } else if (data.phase === 'waiting-health') {
    progressContainer.classList.add('visible');
    progressBar.classList.add('indeterminate');
    progressBar.style.width = '';
  } else {
    progressContainer.classList.remove('visible');
  }

  // Update detail text with color coding based on log level
  detailEl.textContent = data.detail || '';
  detailEl.className = 'detail-text';
  if (data.detail && data.detailLevel) {
    detailEl.classList.add('detail-' + data.detailLevel);
  }
});

/** Handle error from main process */
window.quilltap.onError(function(data) {
  showSection('error');
  logo.classList.remove('pulse');
  changeDirLink.classList.remove('visible');

  errorMessage.textContent = data.message || 'An unexpected error occurred';

  if (!data.canRetry) {
    retryBtn.style.display = 'none';
  } else {
    retryBtn.style.display = '';
  }
});

/** Handle directory info updates from main process */
window.quilltap.onDirectories(function(data) {
  currentSizes = data.sizes || {};
  currentMinServerVersions = data.minServerVersions || {};
  renderDirectoryList(data.dirs, data.lastUsed, currentSizes, currentMinServerVersions);
  autoStartCheckbox.checked = data.autoStart;

  // Update runtime mode state
  currentRuntimeMode = data.runtimeMode || 'vm';
  updateRuntimeButtons();

  // On Linux there is no VM mode, so fallbacks go to the other available runtime
  var isLinux = data.platform === 'linux';

  // Update Docker button availability
  if (data.dockerAvailable) {
    runtimeDockerBtn.disabled = false;
  } else {
    runtimeDockerBtn.disabled = true;
    // Force away from Docker mode if Docker is not available
    if (currentRuntimeMode === 'docker') {
      currentRuntimeMode = isLinux ? 'embedded' : 'vm';
      updateRuntimeButtons();
      window.quilltap.setRuntimeMode(currentRuntimeMode);
    }
  }

  // Embedded mode is always available (uses Electron's own Node.js)
  runtimeEmbeddedBtn.disabled = false;

  // Update VM label
  if (data.vmLabel) {
    vmLabelEl.textContent = data.vmLabel;
  }

  // Update prerelease setting and version selector
  showPrerelease = !!data.showPrerelease;
  updatePrereleaseCheckbox();
  updateVersionSelector(data.availableVersions, data.serverVersion);

  // Show or hide upgrade banner
  if (data.upgradeAvailable) {
    pendingUpgradeVersion = data.upgradeAvailable.to;
    upgradeBannerText.textContent =
      'A newer server is available: ' + data.upgradeAvailable.toLabel +
      ' (you are on ' + data.upgradeAvailable.from + ')';
    upgradeBanner.classList.remove('hidden');
  } else {
    pendingUpgradeVersion = '';
    upgradeBanner.classList.add('hidden');
  }

  // On Linux, hide the VM option — there is no Lima/WSL2 equivalent
  if (data.platform === 'linux') {
    runtimeVMBtn.style.display = 'none';
    runtimeDockerBtn.style.flex = '1';
    runtimeEmbeddedBtn.style.flex = '1';
  }
});

/** Retry button */
retryBtn.addEventListener('click', function() {
  window.quilltap.retry();
});

/** Quit button (error state) */
quitBtn.addEventListener('click', function() {
  window.quilltap.quit();
});

/** Quit button (directory chooser) */
chooserQuitBtn.addEventListener('click', function() {
  window.quilltap.quit();
});

/** Add directory button */
addDirBtn.addEventListener('click', async function() {
  var path = await window.quilltap.selectDirectory();
  if (path) {
    selectedDir = path;
    // The main process sends updated directory info via onDirectories
  }
});

/** Start button */
startBtn.addEventListener('click', function() {
  if (selectedDir) {
    window.quilltap.startWithDirectory(selectedDir);
  }
});

/** Auto-start checkbox */
autoStartCheckbox.addEventListener('change', function() {
  window.quilltap.setAutoStart(autoStartCheckbox.checked);
});

/** Change directory button during loading */
changeDirLink.addEventListener('click', function() {
  window.quilltap.showDirectoryChooser();
});

/** Runtime mode: Docker button */
runtimeDockerBtn.addEventListener('click', function() {
  if (runtimeDockerBtn.disabled) return;
  currentRuntimeMode = 'docker';
  updateRuntimeButtons();
  updateVersionSelector(null, null);
  window.quilltap.setRuntimeMode('docker');
});

/** Runtime mode: VM button */
runtimeVMBtn.addEventListener('click', function() {
  currentRuntimeMode = 'vm';
  updateRuntimeButtons();
  updateVersionSelector(null, null);
  window.quilltap.setRuntimeMode('vm');
});

/** Runtime mode: Direct (embedded) button */
runtimeEmbeddedBtn.addEventListener('click', function() {
  if (runtimeEmbeddedBtn.disabled) return;
  currentRuntimeMode = 'embedded';
  updateRuntimeButtons();
  updateVersionSelector(null, null);
  window.quilltap.setRuntimeMode('embedded');
});

/** Server version selector */
versionSelect.addEventListener('change', function() {
  window.quilltap.setServerVersion(versionSelect.value);
});

/** Prerelease checkbox */
prereleaseCheckbox.addEventListener('change', function() {
  showPrerelease = prereleaseCheckbox.checked;
  updatePrereleaseCheckbox();
  updateVersionSelector(null, null);
  window.quilltap.setShowPrerelease(showPrerelease);
});

/** Delete confirmation: config only */
deleteConfigOnlyBtn.addEventListener('click', async function() {
  if (pendingDeleteDir) {
    await window.quilltap.deleteDirectory(pendingDeleteDir, 'config-only');
    hideDeleteConfirmation();
  }
});

/** Delete confirmation: config and data */
deleteConfigAndDataBtn.addEventListener('click', async function() {
  if (pendingDeleteDir) {
    await window.quilltap.deleteDirectory(pendingDeleteDir, 'config-and-data');
    hideDeleteConfirmation();
  }
});

/** Delete confirmation: cancel */
deleteCancelBtn.addEventListener('click', function() {
  hideDeleteConfirmation();
});

/** VM erase confirmation: confirm */
vmEraseConfirmBtn.addEventListener('click', async function() {
  if (pendingVMEraseDir) {
    await window.quilltap.deleteVM(pendingVMEraseDir);
    hideVMEraseConfirmation();
  }
});

/** VM erase confirmation: cancel */
vmEraseCancelBtn.addEventListener('click', function() {
  hideVMEraseConfirmation();
});

/** Rename: save */
renameSaveBtn.addEventListener('click', async function() {
  if (pendingRenameDir && renameInput.value.trim()) {
    await window.quilltap.renameDirectory(pendingRenameDir, renameInput.value.trim());
    hideRenameDialog();
  }
});

/** Rename: cancel */
renameCancelBtn.addEventListener('click', function() {
  hideRenameDialog();
});

/** Upgrade banner: accept */
upgradeAcceptBtn.addEventListener('click', function() {
  if (pendingUpgradeVersion) {
    window.quilltap.acceptUpgrade(pendingUpgradeVersion);
    pendingUpgradeVersion = '';
    upgradeBanner.classList.add('hidden');
  }
});

/** Upgrade banner: decline */
upgradeDeclineBtn.addEventListener('click', function() {
  if (pendingUpgradeVersion) {
    window.quilltap.declineUpgrade(pendingUpgradeVersion);
    pendingUpgradeVersion = '';
    upgradeBanner.classList.add('hidden');
  }
});

/** Rename: Enter key saves, Escape cancels */
renameInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    renameSaveBtn.click();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideRenameDialog();
  }
});
