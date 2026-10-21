const { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');
const execFileAsync = promisify(execFile);

const START = '<!-- daybook:start -->';
const END = '<!-- daybook:end -->';
const APP_ICON = path.join(__dirname, 'assets', 'daybook-icon.png');
let mainWindow;

app.setName('Daybook');

function normalizeWrikeHost(value) {
  let url;
  try { url = new URL(String(value || 'https://www.wrike.com').trim()); } catch { throw new Error('Enter a valid Wrike HTTPS host.'); }
  if (url.protocol !== 'https:' || !/(^|\.)wrike\.com$/i.test(url.hostname)) throw new Error('Wrike host must be an HTTPS Wrike domain.');
  return url.origin;
}

function normalizeServiceNowInstance(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { throw new Error('Enter your ServiceNow instance host, such as company.service-now.com.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter your ServiceNow instance HTTPS host, such as company.service-now.com.');
  return url.origin;
}

function normalizeVaultFolder(value, fallback) {
  const folder = String(value ?? fallback).trim().replace(/\\/g, '/');
  if (!folder) return fallback;
  if (path.isAbsolute(folder) || /^[A-Za-z]:/.test(folder) || folder.split('/').some((part) => part === '..')) {
    throw new Error('Vault folders must be relative paths inside the selected vault.');
  }
  const normalized = folder.split('/').filter((part) => part && part !== '.').join('/');
  return normalized || fallback;
}

function configuredFolderPath(config, setting, fallback) {
  const folder = normalizeVaultFolder(config[setting], fallback);
  return path.join(config.vaultPath, ...folder.split('/'));
}

function configuredFolderRoots(config, setting, fallback, legacy = '') {
  const root = configuredFolderPath(config, setting, fallback);
  const roots = [root];
  if (legacy && normalizeVaultFolder(config[setting], fallback) === fallback && legacy !== fallback) {
    const legacyRoot = path.join(config.vaultPath, legacy);
    if (legacyRoot !== root) roots.push(legacyRoot);
  }
  return roots;
}

function userConfigPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function daybookDataFolder(vaultPath) {
  return path.join(vaultPath, 'SYSTEM', 'DAYBOOK');
}

async function migrateLegacyDaybookData(vaultPath) {
  if (!vaultPath) return;
  const currentFolder = daybookDataFolder(vaultPath);
  await fs.mkdir(currentFolder, { recursive: true });
  const legacyFolders = [
    path.join(vaultPath, 'Daybook'),
    path.join(vaultPath, '.daybook')
  ];
  for (const name of ['protocol-bundles.json', 'protocol-cycles.json', 'settings.json', 'hevy-workouts-cache.json', 'weight-readings.json']) {
    const destination = path.join(currentFolder, name);
    for (const legacyFolder of legacyFolders) {
      try {
        await fs.copyFile(path.join(legacyFolder, name), destination, fsConstants.COPYFILE_EXCL);
        break;
      } catch (error) {
        if (error.code === 'EEXIST') break;
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function weightReadingsPath(vaultPath) {
  return path.join(daybookDataFolder(vaultPath), 'weight-readings.json');
}

function parseCsvRows(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted && char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      row.push(cell.trim()); cell = '';
      if (row.some((value) => value)) rows.push(row);
      row = [];
      if (char === '\r' && source[index + 1] === '\n') index += 1;
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some((value) => value)) rows.push(row);
  return rows;
}

function parseGarminWeightCsv(text) {
  const rows = parseCsvRows(text);
  const headerIndex = rows.findIndex((row) => row.some((value) => /^(date|time)$/i.test(value.trim())) && row.some((value) => /^weight(?:\s*\([^)]*\))?$/i.test(value.trim())));
  if (headerIndex < 0) throw new Error('Could not find a Garmin weight CSV header. Choose the weight report exported from Garmin Connect.');
  const headers = rows[headerIndex].map((value) => value.trim().toLowerCase());
  const indexOf = (pattern) => headers.findIndex((header) => pattern.test(header));
  const dateColumn = indexOf(/^date$/);
  const timeColumn = indexOf(/^time$/);
  const weightColumn = indexOf(/^weight/);
  const fatColumn = indexOf(/^(body\s*fat|fat)(\s*\(%\))?$/);
  const bmiColumn = indexOf(/^bmi$/);
  let activeDate = '';
  const measurements = [];
  const parseDate = (value) => {
    const clean = String(value || '').replace(/^\uFEFF/, '').trim();
    if (!clean) return '';
    const iso = clean.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    const date = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12) : new Date(clean);
    return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const parseNumber = (value) => {
    const normalized = String(value || '').trim().replace(/,/g, '.').replace(/[^\d.+-]/g, '');
    const number = Number(normalized);
    return Number.isFinite(number) && number > 0 ? number : null;
  };
  for (const row of rows.slice(headerIndex + 1)) {
    if (dateColumn >= 0 && row[dateColumn]) activeDate = parseDate(row[dateColumn]) || activeDate;
    else if (row[0] && !parseNumber(row[weightColumn])) activeDate = parseDate(row[0]) || activeDate;
    const rawWeight = row[weightColumn];
    const numericWeight = parseNumber(rawWeight);
    const date = dateColumn >= 0 ? (parseDate(row[dateColumn]) || activeDate) : activeDate;
    if (!date || !numericWeight) continue;
    const rawText = String(rawWeight || '').toLowerCase();
    const weightKg = /\b(lb|lbs|pound|pounds)\b/.test(rawText) || /\blb\b/.test(headers[weightColumn] || '') ? numericWeight / 2.2046226218 : numericWeight;
    const time = timeColumn >= 0 ? String(row[timeColumn] || '').trim() : '';
    const timestamp = time ? new Date(`${date} ${time}`) : new Date(`${date}T12:00:00`);
    measurements.push({
      date, timestamp: Number.isNaN(timestamp.getTime()) ? `${date}T12:00:00` : timestamp.toISOString(),
      weightKg: Math.round(weightKg * 1000) / 1000,
      bodyFatPercent: fatColumn >= 0 ? parseNumber(row[fatColumn]) : null,
      bmi: bmiColumn >= 0 ? parseNumber(row[bmiColumn]) : null,
      source: 'Garmin Connect'
    });
  }
  if (!measurements.length) throw new Error('No weight readings were found in that CSV. Check that it is a Garmin Connect weight report.');
  return measurements;
}

async function handleListWeightReadings() {
  const config = await readConfig();
  ensureConfigured(config);
  try {
    const data = JSON.parse(await fs.readFile(weightReadingsPath(config.vaultPath), 'utf8'));
    return Array.isArray(data.readings) ? data.readings : [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function handleImportGarminWeightCsv() {
  const config = await readConfig();
  ensureConfigured(config);
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Import Garmin Connect weight report', properties: ['openFile'], filters: [{ name: 'CSV files', extensions: ['csv'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true, imported: 0, readings: await handleListWeightReadings() };
  const file = result.filePaths[0];
  const stat = await fs.stat(file);
  if (stat.size > 10 * 1024 * 1024) throw new Error('That CSV is larger than 10 MB. Export a shorter date range and try again.');
  const imported = parseGarminWeightCsv(await fs.readFile(file, 'utf8'));
  const previous = await handleListWeightReadings();
  const merged = new Map(previous.map((entry) => [`${entry.timestamp}|${entry.weightKg}`, entry]));
  for (const entry of imported) merged.set(`${entry.timestamp}|${entry.weightKg}`, entry);
  const readings = [...merged.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const destination = weightReadingsPath(config.vaultPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), readings }, null, 2), 'utf8');
  await fs.rename(temporary, destination);
  return { canceled: false, imported: imported.length, readings };
}

function dexaScansFolder(config) {
  return path.join(configuredFolderPath(config, 'wellnessFolder', 'Wellness'), 'DEXA Scans');
}

async function handleChooseDexaReport(date) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Attach DEXA report', properties: ['openFile'], filters: [{ name: 'DEXA report', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'tif', 'tiff'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const source = result.filePaths[0];
  const stats = await fs.stat(source);
  if (stats.size > 30 * 1024 * 1024) throw new Error('The DEXA report is larger than 30 MB. Choose a smaller PDF or image.');
  const extension = path.extname(source).toLowerCase();
  const attachmentFolder = normalizeVaultFolder(config.attachmentsFolder, 'Attachments');
  const baseName = `DEXA-${date}`;
  let filename = `${baseName}${extension}`;
  let index = 2;
  while (true) {
    try { await fs.access(path.join(config.vaultPath, ...attachmentFolder.split('/'), filename)); filename = `${baseName}-${index++}${extension}`; }
    catch { break; }
  }
  const relativePath = safeRelative(attachmentFolder, filename).split(path.sep).join('/');
  const destination = path.join(config.vaultPath, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return { canceled: false, relativePath, filename };
}

function dexaNumber(value, label, allowZero = false) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} number.`);
  return Math.round(number * 1000) / 1000;
}

async function handleSaveDexaScan(input = {}) {
  const config = await readConfig();
  ensureConfigured(config);
  const date = String(input.date || '');
  ensureDate(date);
  const fields = {
    body_fat_percent: dexaNumber(input.bodyFatPercent, 'Body fat percentage', true),
    fat_mass_lb: dexaNumber(input.fatMassLb, 'Fat mass'),
    lean_mass_lb: dexaNumber(input.leanMassLb, 'Lean mass'),
    bone_mineral_content_lb: dexaNumber(input.boneMineralContentLb, 'Bone mineral content'),
    visceral_fat_g: dexaNumber(input.visceralFatG, 'Visceral fat', true),
    android_gynoid_ratio: dexaNumber(input.androidGynoidRatio, 'Android/gynoid ratio'),
    bone_mineral_density_g_cm2: dexaNumber(input.boneMineralDensity, 'Bone mineral density')
  };
  const report = typeof input.reportPath === 'string' ? input.reportPath.trim() : '';
  if (report) {
    if (path.isAbsolute(report) || /^[A-Za-z]:/.test(report)) throw new Error('The attached report must be stored inside the selected vault.');
    const relativeReport = safeRelative('', report);
    const vaultRoot = path.resolve(config.vaultPath);
    const reportPath = path.resolve(vaultRoot, relativeReport);
    if (!reportPath.startsWith(`${vaultRoot}${path.sep}`)) throw new Error('The attached report must be stored inside the selected vault.');
    const attachmentRoot = path.resolve(vaultRoot, ...normalizeVaultFolder(config.attachmentsFolder, 'Attachments').split('/'));
    if (!reportPath.startsWith(`${attachmentRoot}${path.sep}`)) throw new Error('Choose the report with the attachment button so it is saved in the configured attachments folder.');
    const reportStats = await fs.stat(reportPath).catch(() => null);
    if (!reportStats?.isFile()) throw new Error('The attached report could not be found in the vault. Attach it again and retry.');
  }
  const noteFolder = dexaScansFolder(config);
  await fs.mkdir(noteFolder, { recursive: true });
  const baseName = `DEXA-${date}`;
  let filename = `${baseName}.md`, suffix = 2;
  while (true) {
    try { await fs.access(path.join(noteFolder, filename)); filename = `${baseName}-${suffix++}.md`; }
    catch { break; }
  }
  const title = `DEXA Scan ${date}`;
  const propertyLines = [
    '---', 'type: dexa-scan', `scan_date: ${date}`,
    ...Object.entries(fields).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`),
    ...(report ? [`report: ${yamlScalar(report)}`] : []), '---'
  ];
  const noteBody = `${propertyLines.join('\n')}\n\n# ${title}\n\n${String(input.notes || '').trim()}${report ? `${input.notes ? '\n\n' : ''}## Report\n\n[[${report}]]` : ''}\n`;
  const relativePath = path.relative(config.vaultPath, path.join(noteFolder, filename)).split(path.sep).join('/');
  await fs.writeFile(path.join(noteFolder, filename), noteBody, 'utf8');
  return { relativePath, title, date, ...fields, reportPath: report };
}

async function handleListDexaScans() {
  const config = await readConfig();
  ensureConfigured(config);
  const folder = dexaScansFolder(config);
  let entries;
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const scans = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md'))) {
    const fullPath = path.join(folder, entry.name);
    const content = await fs.readFile(fullPath, 'utf8');
    const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const frontmatter = match?.[1] || '';
    if (frontmatterValue(frontmatter, ['type']) !== 'dexa-scan') continue;
    const value = (key) => frontmatterValue(frontmatter, [key]);
    const number = (key) => { const parsed = Number(value(key)); return value(key) && Number.isFinite(parsed) ? parsed : null; };
    const notes = content.slice(match?.[0].length || 0).replace(/^\s*#.*(?:\r?\n)?/, '').replace(/\r?\n## Report[\s\S]*$/, '').trim();
    scans.push({ title: path.basename(entry.name, '.md').replace(/-/g, ' '), date: value('scan_date'), relativePath: path.relative(config.vaultPath, fullPath).split(path.sep).join('/'), bodyFatPercent: number('body_fat_percent'), fatMassLb: number('fat_mass_lb'), leanMassLb: number('lean_mass_lb'), boneMineralContentLb: number('bone_mineral_content_lb'), visceralFatG: number('visceral_fat_g'), androidGynoidRatio: number('android_gynoid_ratio'), boneMineralDensity: number('bone_mineral_density_g_cm2'), reportPath: value('report'), notes });
  }
  return scans.sort((a, b) => b.date.localeCompare(a.date));
}

function hevyWorkoutCachePath(vaultPath = '') {
  return vaultPath
    ? path.join(daybookDataFolder(vaultPath), 'hevy-workouts-cache.json')
    : path.join(app.getPath('userData'), 'hevy-workouts-cache.json');
}

function sharedSettingsPath(vaultPath) {
  return path.join(daybookDataFolder(vaultPath), 'settings.json');
}

async function readSharedSettings(vaultPath) {
  if (!vaultPath) return {};
  try {
    await migrateLegacyDaybookData(vaultPath);
    const shared = JSON.parse(await fs.readFile(sharedSettingsPath(vaultPath), 'utf8'));
    return shared && typeof shared === 'object' && !Array.isArray(shared) ? shared : {};
  } catch {
    return {};
  }
}

function sharedSettingsFromConfig(config) {
  return {
    dailyFolder: config.dailyFolder,
    attachmentsFolder: config.attachmentsFolder,
    habitsFolder: config.habitsFolder,
    projectsFolder: config.projectsFolder,
    meetingsFolder: config.meetingsFolder,
    peopleFolder: config.peopleFolder,
    wellnessFolder: config.wellnessFolder,
    workoutPlans: config.workoutPlans,
    morningRoutine: config.morningRoutine,
    eveningRoutine: config.eveningRoutine,
    matrixFilters: config.matrixFilters,
    modules: config.modules,
    appearance: config.appearance
  };
}

async function writeSharedSettings(vaultPath, config) {
  if (!vaultPath) return;
  await migrateLegacyDaybookData(vaultPath);
  const file = sharedSettingsPath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(sharedSettingsFromConfig(config), null, 2), 'utf8');
  await fs.rename(temporaryFile, file);
}

async function readHevyWorkoutCache(credentialHash = '', vaultPath = '') {
  try {
    const cached = JSON.parse(await fs.readFile(hevyWorkoutCachePath(vaultPath), 'utf8'));
    if (!Array.isArray(cached.workouts)) return null;
    if (credentialHash && cached.credentialHash && cached.credentialHash !== credentialHash) return null;
    return cached;
  } catch {
    if (!vaultPath) return null;
    try {
      const cached = JSON.parse(await fs.readFile(hevyWorkoutCachePath(), 'utf8'));
      if (!Array.isArray(cached.workouts)) return null;
      if (credentialHash && cached.credentialHash && cached.credentialHash !== credentialHash) return null;
      return cached;
    } catch { return null; }
  }
}

async function writeHevyWorkoutCache(workouts, cachedAt, vaultPath = '') {
  const file = hevyWorkoutCachePath(vaultPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify({ cachedAt, workouts }), 'utf8');
  await fs.rename(temporaryFile, file);
}

async function readConfig() {
  try {
    const saved = JSON.parse(await fs.readFile(userConfigPath(), 'utf8'));
    const shared = await readSharedSettings(saved.vaultPath || '');
    let todoistToken = '';
    let hevyApiKey = '';
    let wrikeToken = '';
    let serviceNowPassword = '';
    let serviceNowToken = '';
    let whoopClientSecret = '';
    let whoopAccessToken = '';
    let whoopRefreshToken = '';
    if (saved.encryptedToken && safeStorage.isEncryptionAvailable()) {
      todoistToken = safeStorage.decryptString(Buffer.from(saved.encryptedToken, 'base64'));
    }
    if (saved.encryptedHevyApiKey && safeStorage.isEncryptionAvailable()) {
      hevyApiKey = safeStorage.decryptString(Buffer.from(saved.encryptedHevyApiKey, 'base64'));
    }
    if (saved.encryptedWrikeToken && safeStorage.isEncryptionAvailable()) wrikeToken = safeStorage.decryptString(Buffer.from(saved.encryptedWrikeToken, 'base64'));
    if (saved.encryptedServiceNowPassword && safeStorage.isEncryptionAvailable()) serviceNowPassword = safeStorage.decryptString(Buffer.from(saved.encryptedServiceNowPassword, 'base64'));
    if (saved.encryptedServiceNowToken && safeStorage.isEncryptionAvailable()) serviceNowToken = safeStorage.decryptString(Buffer.from(saved.encryptedServiceNowToken, 'base64'));
    if (saved.encryptedWhoopClientSecret && safeStorage.isEncryptionAvailable()) whoopClientSecret = safeStorage.decryptString(Buffer.from(saved.encryptedWhoopClientSecret, 'base64'));
    if (saved.encryptedWhoopAccessToken && safeStorage.isEncryptionAvailable()) whoopAccessToken = safeStorage.decryptString(Buffer.from(saved.encryptedWhoopAccessToken, 'base64'));
    if (saved.encryptedWhoopRefreshToken && safeStorage.isEncryptionAvailable()) whoopRefreshToken = safeStorage.decryptString(Buffer.from(saved.encryptedWhoopRefreshToken, 'base64'));
    return {
      vaultPath: saved.vaultPath || '',
      dailyFolder: shared.dailyFolder || saved.dailyFolder || 'Daily',
      attachmentsFolder: shared.attachmentsFolder || saved.attachmentsFolder || 'Attachments',
      habitsFolder: shared.habitsFolder || saved.habitsFolder || 'Habits',
      projectsFolder: (() => { try { return normalizeVaultFolder(shared.projectsFolder ?? saved.projectsFolder, 'PROJECTS'); } catch { return 'PROJECTS'; } })(),
      meetingsFolder: (() => { try { return normalizeVaultFolder(shared.meetingsFolder ?? saved.meetingsFolder, 'MEETINGS'); } catch { return 'MEETINGS'; } })(),
      peopleFolder: (() => { try { return normalizeVaultFolder(shared.peopleFolder ?? saved.peopleFolder, 'People'); } catch { return 'People'; } })(),
      workoutPlans: (shared.workoutPlans ?? saved.workoutPlans) && typeof (shared.workoutPlans ?? saved.workoutPlans) === 'object' && !Array.isArray(shared.workoutPlans ?? saved.workoutPlans) ? (shared.workoutPlans ?? saved.workoutPlans) : {},
      morningRoutine: Array.isArray(shared.morningRoutine ?? saved.morningRoutine) ? (shared.morningRoutine ?? saved.morningRoutine) : ['Drink water', 'Move for 10 minutes', 'Review today'],
      eveningRoutine: Array.isArray(shared.eveningRoutine ?? saved.eveningRoutine) ? (shared.eveningRoutine ?? saved.eveningRoutine) : ['Reset my space', 'Reflect on the day', 'Prepare for tomorrow'],
      matrixFilters: (shared.matrixFilters ?? saved.matrixFilters) && typeof (shared.matrixFilters ?? saved.matrixFilters) === 'object' ? (shared.matrixFilters ?? saved.matrixFilters) : { do: '', schedule: '', delegate: '', later: '' },
      calendarEnabled: Boolean(saved.calendarEnabled),
      calendarSupported: process.platform === 'darwin',
      todoistToken,
      hevyApiKey,
      wrikeToken,
      wrikeHost: saved.wrikeHost || 'https://www.wrike.com',
      serviceNowInstance: saved.serviceNowInstance || '',
      serviceNowUser: saved.serviceNowUser || '',
      serviceNowAuthType: ['apiKey', 'bearer', 'basic'].includes(saved.serviceNowAuthType) ? saved.serviceNowAuthType : (saved.encryptedServiceNowPassword ? 'basic' : 'apiKey'),
      serviceNowToken,
      serviceNowPassword,
      whoopClientId: saved.whoopClientId || '',
      whoopClientSecret,
      whoopAccessToken,
      whoopRefreshToken,
      whoopExpiresAt: Number(saved.whoopExpiresAt) || 0,
      wellnessFolder: shared.wellnessFolder || saved.wellnessFolder || 'Wellness',
      modules: { habits: (shared.modules ?? saved.modules)?.habits !== false, wellness: (shared.modules ?? saved.modules)?.wellness !== false, todoist: (shared.modules ?? saved.modules)?.todoist !== false, hevy: (shared.modules ?? saved.modules)?.hevy !== false, wrike: (shared.modules ?? saved.modules)?.wrike !== false, serviceNow: (shared.modules ?? saved.modules)?.serviceNow !== false, whoop: (shared.modules ?? saved.modules)?.whoop !== false },
      appearance: {
        mode: ['system', 'light', 'dark'].includes((shared.appearance ?? saved.appearance)?.mode) ? (shared.appearance ?? saved.appearance).mode : 'system',
        color: ['blue', 'violet', 'green', 'rose', 'amber'].includes((shared.appearance ?? saved.appearance)?.color) ? (shared.appearance ?? saved.appearance).color : 'blue'
      }
    };
  } catch {
    return {
      vaultPath: '', dailyFolder: 'Daily', attachmentsFolder: 'Attachments', habitsFolder: 'Habits', projectsFolder: 'PROJECTS', meetingsFolder: 'MEETINGS', peopleFolder: 'People',
      workoutPlans: {},
      morningRoutine: ['Drink water', 'Move for 10 minutes', 'Review today'],
      eveningRoutine: ['Reset my space', 'Reflect on the day', 'Prepare for tomorrow'],
      matrixFilters: { do: '', schedule: '', delegate: '', later: '' },
      calendarEnabled: false,
      calendarSupported: process.platform === 'darwin',
      todoistToken: '', hevyApiKey: '', wrikeToken: '', wrikeHost: 'https://www.wrike.com', serviceNowInstance: '', serviceNowUser: '', serviceNowAuthType: 'apiKey', serviceNowToken: '', serviceNowPassword: '', whoopClientId: '', whoopClientSecret: '', whoopAccessToken: '', whoopRefreshToken: '', whoopExpiresAt: 0, wellnessFolder: 'Wellness',
      modules: { habits: true, wellness: true, todoist: true, hevy: true, wrike: true, serviceNow: true, whoop: true },
      appearance: { mode: 'system', color: 'blue' }
    };
  }
}

async function writeConfig(next) {
  const old = await readConfig();
  const switchedVault = Boolean(next.vaultPath && next.vaultPath !== old.vaultPath);
  const targetVaultSettings = switchedVault ? await readSharedSettings(next.vaultPath) : {};
  const base = { ...old, ...targetVaultSettings };
  const token = next.todoistToken ?? old.todoistToken;
  const hevyApiKey = next.hevyApiKey ?? old.hevyApiKey;
  const wrikeToken = next.wrikeToken ?? old.wrikeToken;
  const serviceNowPassword = next.serviceNowPassword ?? old.serviceNowPassword;
  const serviceNowToken = next.serviceNowToken ?? old.serviceNowToken;
  const whoopClientSecret = String(next.whoopClientSecret || old.whoopClientSecret || '');
  const whoopAccessToken = next.whoopAccessToken ?? old.whoopAccessToken;
  const whoopRefreshToken = next.whoopRefreshToken ?? old.whoopRefreshToken;
  if ((token || hevyApiKey || wrikeToken || serviceNowPassword || serviceNowToken || whoopClientSecret || whoopAccessToken || whoopRefreshToken) && !safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this device, so Daybook cannot save integration credentials safely.');
  }
  const saved = {
    vaultPath: next.vaultPath ?? old.vaultPath,
    dailyFolder: next.dailyFolder ?? base.dailyFolder,
    attachmentsFolder: next.attachmentsFolder ?? base.attachmentsFolder,
    habitsFolder: next.habitsFolder ?? base.habitsFolder,
    projectsFolder: normalizeVaultFolder(next.projectsFolder ?? base.projectsFolder, 'PROJECTS'),
    meetingsFolder: normalizeVaultFolder(next.meetingsFolder ?? base.meetingsFolder, 'MEETINGS'),
    peopleFolder: normalizeVaultFolder(next.peopleFolder ?? base.peopleFolder, 'People'),
    workoutPlans: Object.fromEntries(Object.entries(next.workoutPlans ?? base.workoutPlans ?? {}).filter(([date, routine]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof routine === 'string' && routine.trim()).slice(-370).map(([date, routine]) => [date, routine.trim().slice(0, 120)])),
    wellnessFolder: next.wellnessFolder ?? base.wellnessFolder,
    wrikeHost: normalizeWrikeHost(next.wrikeHost ?? old.wrikeHost),
    serviceNowInstance: normalizeServiceNowInstance(next.serviceNowInstance ?? old.serviceNowInstance),
    serviceNowUser: String(next.serviceNowUser ?? old.serviceNowUser).trim().slice(0, 200),
    serviceNowAuthType: ['apiKey', 'bearer', 'basic'].includes(next.serviceNowAuthType) ? next.serviceNowAuthType : old.serviceNowAuthType,
    whoopClientId: String(next.whoopClientId ?? old.whoopClientId).trim().slice(0, 200),
    whoopExpiresAt: Number(next.whoopExpiresAt ?? old.whoopExpiresAt) || 0,
    morningRoutine: next.morningRoutine ?? base.morningRoutine,
    eveningRoutine: next.eveningRoutine ?? base.eveningRoutine,
    matrixFilters: next.matrixFilters ?? base.matrixFilters,
    calendarEnabled: next.calendarEnabled ?? old.calendarEnabled,
    modules: { ...base.modules, ...(next.modules || {}) },
    appearance: {
      mode: ['system', 'light', 'dark'].includes(next.appearance?.mode) ? next.appearance.mode : (base.appearance?.mode || 'system'),
      color: ['blue', 'violet', 'green', 'rose', 'amber'].includes(next.appearance?.color) ? next.appearance.color : (base.appearance?.color || 'blue')
    },
    encryptedToken: token && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(token).toString('base64')
      : '',
    encryptedHevyApiKey: hevyApiKey && safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(hevyApiKey).toString('base64')
      : '',
    encryptedWrikeToken: wrikeToken && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(wrikeToken).toString('base64') : '',
    encryptedServiceNowPassword: serviceNowPassword && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(serviceNowPassword).toString('base64') : '',
    encryptedServiceNowToken: serviceNowToken && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(serviceNowToken).toString('base64') : '',
    encryptedWhoopClientSecret: whoopClientSecret && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(whoopClientSecret).toString('base64') : '',
    encryptedWhoopAccessToken: whoopAccessToken && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(whoopAccessToken).toString('base64') : '',
    encryptedWhoopRefreshToken: whoopRefreshToken && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(whoopRefreshToken).toString('base64') : ''
  };
  await fs.mkdir(path.dirname(userConfigPath()), { recursive: true });
  await fs.writeFile(userConfigPath(), JSON.stringify(saved, null, 2), 'utf8');
  await writeSharedSettings(saved.vaultPath, saved);
  return { ...saved, calendarSupported: process.platform === 'darwin', todoistToken: token, hevyApiKey, wrikeToken, serviceNowToken, serviceNowPassword, whoopClientSecret, whoopAccessToken, whoopRefreshToken, wellnessFolder: saved.wellnessFolder, attachmentsFolder: saved.attachmentsFolder, workoutPlans: saved.workoutPlans || {} };
}

const WHOOP_REDIRECT_URI = 'http://localhost:43821/whoop/callback';
async function whoopTokenRequest(body, config) {
  const response = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ ...body, client_id: config.whoopClientId, client_secret: config.whoopClientSecret }).toString() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.message || `WHOOP token request failed (${response.status}).`);
  const updated = await writeConfig({ ...config, whoopAccessToken: payload.access_token, whoopRefreshToken: payload.refresh_token || config.whoopRefreshToken, whoopExpiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 });
  return updated;
}

async function handleWhoopConnect() {
  const config = await readConfig();
  if (!config.whoopClientId || !config.whoopClientSecret) throw new Error('Enter your WHOOP Client ID and Client Secret in Settings first.');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(43821, '127.0.0.1', resolve);
  }).catch((error) => { throw new Error(error.code === 'EADDRINUSE' ? 'The WHOOP sign-in return address is already in use. Close the other Daybook window and try again.' : `Could not start WHOOP sign-in (${error.message}).`); });
  const callback = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WHOOP sign-in timed out. Try connecting again.')), 180000);
    server.on('request', (req, res) => {
      const url = new URL(req.url, WHOOP_REDIRECT_URI);
      if (url.pathname !== '/whoop/callback') { res.writeHead(404).end(); return; }
      if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Sign-in could not be verified. Return to Daybook and try again.'); clearTimeout(timeout); reject(new Error('WHOOP sign-in could not be verified.')); return; }
      const code = url.searchParams.get('code');
      const denied = url.searchParams.get('error_description') || url.searchParams.get('error');
      res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<html><body style="font:16px -apple-system;padding:40px;color:#222"><h2>${code ? 'WHOOP connected' : 'WHOOP connection not completed'}</h2><p>You can return to Daybook.</p></body></html>`);
      clearTimeout(timeout);
      if (code) resolve(code); else reject(new Error(denied || 'WHOOP authorization was canceled.'));
    });
  });
  try {
    const params = new URLSearchParams({ client_id: config.whoopClientId, redirect_uri: WHOOP_REDIRECT_URI, response_type: 'code', scope: 'offline read:recovery read:cycles read:workout read:sleep read:body_measurement', state });
    await shell.openExternal(`https://api.prod.whoop.com/oauth/oauth2/auth?${params}`);
    const code = await callback;
    const updated = await whoopTokenRequest({ grant_type: 'authorization_code', code, redirect_uri: WHOOP_REDIRECT_URI }, config);
    return { connected: true, config: updated };
  } finally { server.close(); }
}

async function whoopGet(pathname, config) {
  const current = config;
  if (!current.whoopAccessToken) return { connected: false, recovery: null, sleep: null, cycle: null, workouts: [] };
  const response = await fetch(`https://api.prod.whoop.com/developer/v2/${pathname}`, { headers: { Authorization: `Bearer ${current.whoopAccessToken}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'WHOOP authorization expired or was revoked. Reconnect in Settings.' : `WHOOP data request failed (${response.status}).`);
  return response.json();
}

async function handleWhoopSummary() {
  let config = await readConfig();
  if (!config.whoopAccessToken && !config.whoopRefreshToken) return { connected: false, recovery: null, sleep: null, cycle: null, workouts: [] };
  if ((!config.whoopAccessToken || config.whoopExpiresAt < Date.now() + 60000) && config.whoopRefreshToken) config = await whoopTokenRequest({ grant_type: 'refresh_token', refresh_token: config.whoopRefreshToken, scope: 'offline' }, config);
  const start = new Date(Date.now() - 10 * 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  const range = `?limit=25&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const [recovery, sleep, cycle, workouts, body] = await Promise.all([
    whoopGet(`recovery${range}`, config), whoopGet(`sleep${range}`, config), whoopGet(`cycle${range}`, config), whoopGet(`workout${range}`, config), whoopGet('user/measurement/body', config).catch(() => null)
  ]);
  const latest = (result) => (result.records || []).sort((a, b) => String(b.created_at || b.start || '').localeCompare(String(a.created_at || a.start || '')))[0] || null;
  return { connected: true, recovery: latest(recovery), sleep: latest(sleep), cycle: latest(cycle), workouts: (workouts.records || []).slice(0, 5), body, refreshedAt: new Date().toISOString() };
}

function publicConfig(config) {
  const { whoopClientSecret, whoopAccessToken, whoopRefreshToken, ...visible } = config;
  return { ...visible, whoopConnected: Boolean(whoopAccessToken || whoopRefreshToken) };
}

function ensureConfigured(config) {
  if (!config.vaultPath) throw new Error('Choose your Obsidian vault in Settings first.');
}

function ensureDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid calendar date.');
}

function safeRelative(folder, filename) {
  const clean = `${folder}/${filename}`.split(/[\\/]/).filter(Boolean);
  if (clean.some((part) => part === '..')) throw new Error('Folder paths cannot go outside the vault.');
  return path.join(...clean);
}

function ordinalDay(day) {
  const remainder = day % 100;
  const suffix = remainder >= 11 && remainder <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
  return `${day}${suffix}`;
}

function formatDailyNoteName(date, format) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(year, month - 1, day, 12);
  const parts = {
    YYYY: String(year), YY: String(year).slice(-2),
    MMMM: value.toLocaleString(undefined, { month: 'long' }),
    MMM: value.toLocaleString(undefined, { month: 'short' }),
    MM: String(month).padStart(2, '0'), M: String(month),
    Do: ordinalDay(day), DD: String(day).padStart(2, '0'), D: String(day),
    dddd: value.toLocaleString(undefined, { weekday: 'long' }),
    ddd: value.toLocaleString(undefined, { weekday: 'short' }),
    dd: value.toLocaleString(undefined, { weekday: 'narrow' }), d: String(value.getDay()),
    HH: '00', H: '0', hh: '12', h: '12', mm: '00', m: '0', ss: '00', s: '0', A: 'AM', a: 'am'
  };
  const tokens = Object.keys(parts).sort((a, b) => b.length - a.length);
  return format.replace(/\[[^\]]*\]|YYYY|MMMM|dddd|MMM|ddd|YY|MM|Do|DD|dd|HH|hh|M|D|d|H|h|mm|m|ss|s|A|a/g, (token) => {
    if (token.startsWith('[')) return token.slice(1, -1);
    return parts[token];
  });
}

function parseCheckboxList(source = '') {
  return source.split(/\r?\n/)
    .map((line) => line.match(/^\s*- \[(x| )\] (.*)$/i))
    .filter(Boolean)
    .map((match) => ({ done: match[1].toLowerCase() === 'x', text: match[2] }));
}

function parseDayBlock(content) {
  const block = content.match(/<!-- daybook:start -->([\s\S]*?)<!-- daybook:end -->/);
  const result = { plan: [], selectedWork: [], calendarChecks: {}, morning: [], evening: [], journal: '', imagePath: '' };
  if (!block) return result;
  const inner = block[1];
  const encodedCalendarChecks = inner.match(/<!-- daybook-calendar-checks:([A-Za-z0-9+/=]+) -->/)?.[1];
  if (encodedCalendarChecks) {
    try { result.calendarChecks = JSON.parse(Buffer.from(encodedCalendarChecks, 'base64').toString('utf8')) || {}; } catch {}
  }
  result.imagePath = inner.match(/!\[\[([^\]]+)\]\]/)?.[1]?.trim() || '';
  const sectionNames = ['Plan', 'Selected work', 'Morning routine', 'Evening routine', 'Journal'];
  for (const [index, name] of sectionNames.entries()) {
    const start = inner.indexOf(`### ${name}`);
    if (start < 0) continue;
    const bodyStart = inner.indexOf('\n', start) + 1;
    let bodyEnd = inner.length;
    for (const other of sectionNames.slice(index + 1)) {
      const next = inner.indexOf(`### ${other}`, bodyStart);
      if (next >= 0) bodyEnd = Math.min(bodyEnd, next);
    }
    const body = inner.slice(bodyStart, bodyEnd).trim();
    if (name === 'Plan') result.plan = parseCheckboxList(body);
    if (name === 'Selected work') {
      result.selectedWork = body.split(/\r?\n/).map((line) => {
        const encoded = line.match(/<!-- daybook-work:([A-Za-z0-9+/=]+) -->/)?.[1];
        if (!encoded) return null;
        try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { return null; }
      }).filter((item) => item && typeof item.source === 'string');
    }
    if (name === 'Morning routine') result.morning = parseCheckboxList(body);
    if (name === 'Evening routine') result.evening = parseCheckboxList(body);
    if (name === 'Journal') result.journal = body;
  }
  return result;
}

function logSectionLines(content) {
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^# Log\s*$/.test(line));
  if (heading < 0) return { lines, heading: -1, end: -1, body: [] };
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index += 1) {
    // Protocol snapshots are appended to the daily note and may appear below
    // `# Log`. Keep them outside the journal section even though their nested
    // headings use `##`/`###` and would otherwise be treated as log content.
    if (/^#\s+/.test(lines[index]) || lines[index].trim() === '<!-- daybook:protocol:start -->') {
      end = index;
      break;
    }
  }
  return { lines, heading, end, body: lines.slice(heading + 1, end) };
}

function parseLogEntries(bodyLines) {
  const entries = [];
  const legacy = [];
  let current = null;
  for (const line of bodyLines) {
    const match = line.match(/^(\d{14})(?:\s+(.*))?$/);
    if (match) {
      current = { timestamp: match[1], text: match[2] || '', tags: [] };
      entries.push(current);
    } else if (current && /^Tags:\s*(?:#[^\s]+\s*)+$/i.test(line)) {
      current.tags = line.replace(/^Tags:\s*/i, '').split(/\s+/).map((tag) => tag.replace(/^#+/, '').trim()).filter(Boolean);
    } else if (current && /^Context:\s*/i.test(line)) {
      current.contextText = line.replace(/^Context:\s*/i, '').trim();
    } else if (current && /^<!-- daybook-journal-context:[A-Za-z0-9+/=]+ -->$/.test(line)) {
      try { current.context = JSON.parse(Buffer.from(line.match(/^<!-- daybook-journal-context:([A-Za-z0-9+/=]+) -->$/)[1], 'base64').toString('utf8')) || []; } catch { current.context = []; }
    } else if (current) {
      current.text += `${current.text ? '\n' : ''}${line}`;
    } else {
      legacy.push(line);
    }
  }
  return { entries, legacy: legacy.join('\n').trim() };
}

function replaceLogEntry(bodyLines, timestamp, journal, tags = [], context = []) {
  const lines = [...bodyLines];
  const start = lines.findIndex((line) => line.startsWith(timestamp) && /^\d{14}(?:\s|$)/.test(line));
  let end = start < 0 ? -1 : lines.length;
  if (start >= 0) {
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\d{14}(?:\s|$)/.test(lines[index])) { end = index; break; }
    }
  }
  if (!journal.trim()) {
    if (start >= 0) lines.splice(start, end - start);
    return lines;
  }
  const entryLines = [`${timestamp} ${journal.trim()}`];
  if (tags.length) entryLines.push(`Tags: ${tags.map((tag) => `#${tag}`).join(' ')}`);
  if (context.length) {
    const labels = context.map((item) => item.relativePath
      ? `[[${String(item.relativePath).replace(/\\/g, '/').replace(/\.md$/i, '')}|${String(item.label || 'Open note').replace(/[|\]\\]/g, '')}]]`
      : `${String(item.source || item.type || 'Linked').replace(/[^\w -]/g, '')}: ${String(item.label || '').replace(/[\r\n]/g, ' ')}`);
    entryLines.push(`Context: ${labels.join(', ')}`);
    const encoded = Buffer.from(JSON.stringify(context)).toString('base64');
    entryLines.push(`<!-- daybook-journal-context:${encoded} -->`);
  }
  if (start >= 0) lines.splice(start, end - start, ...entryLines);
  else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push(...entryLines);
  }
  return lines;
}

function updateLogSection(content, journal, timestamp = '', tags = [], context = []) {
  const section = logSectionLines(content);
  if (!timestamp || !journal.trim()) {
    if (!journal.trim() && timestamp && section.heading >= 0) {
      const nextBody = replaceLogEntry(section.body, timestamp, '', [], []);
      return [...section.lines.slice(0, section.heading + 1), ...nextBody, ...section.lines.slice(section.end)].join('\n');
    }
    if (!journal.trim()) return content;
  }
  const entryTimestamp = timestamp || compactTimestamp(new Date());
  const parsed = parseLogEntries(section.body);
  const body = !timestamp && section.heading >= 0 && !parsed.entries.length && parsed.legacy === journal.trim()
    ? [`${entryTimestamp} ${journal.trim()}`]
    : replaceLogEntry(section.body, entryTimestamp, journal, tags, context);
  if (section.heading < 0) {
    const prefix = content.trimEnd();
    return `${prefix ? `${prefix}\n\n` : ''}# Log\n\n${body.join('\n').trim()}\n`;
  }
  return [...section.lines.slice(0, section.heading + 1), ...body, ...section.lines.slice(section.end)].join('\n');
}

function compactTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function serializeDayBlock(day) {
  const list = (items) => items.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
  const calendarChecks = Buffer.from(JSON.stringify(day.calendarChecks || {})).toString('base64');
  const selectedWork = (day.selectedWork || []).map((item) => {
    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
    const text = String(item.content || item.text || 'Selected task').replace(/[\r\n]+/g, ' ');
    return `- [ ] ${text} <!-- daybook-work:${encoded} -->`;
  }).join('\n');
  const lines = [
    START,
    `<!-- daybook-calendar-checks:${calendarChecks} -->`,
    '### Plan',
    list(day.plan || []),
    '',
    '### Selected work',
    selectedWork,
    '',
    '### Morning routine',
    list(day.morning || []),
    '',
    '### Evening routine',
    list(day.evening || []),
  ];
  if (day.imagePath) lines.push('', '### Image of the day', `![[${day.imagePath}]]`);
  lines.push('', END);
  return lines.join('\n');
}

function updateDayBlock(content, day) {
  const block = serializeDayBlock(day);
  const existing = new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  if (existing.test(content)) return content.replace(existing, block);
  const prefix = content.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ''}${block}\n`;
}

function parseHabit(filePath, content, root) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || !isHabitFrontmatter(frontmatter[1])) return null;
  const name = path.basename(filePath, path.extname(filePath));
  const completedMatch = frontmatter[1].match(/^completed:[ \t]*(?:\r?\n((?:[ \t]+-\s*.*(?:\r?\n|$))*))?/m);
  const inlineCompleted = frontmatter[1].match(/^completed:\s*\[([^\]]*)\]\s*$/m)?.[1];
  const completed = inlineCompleted?.trim()
    ? inlineCompleted.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : completedMatch?.[1]
    ? completedMatch[1].split(/\r?\n/).map((line) => line.match(/^\s+-\s*["']?([^"']+?)["']?\s*$/)?.[1]).filter(Boolean)
    : [];
  return {
    name,
    relativePath: path.relative(root, filePath).split(path.sep).join('/'),
    completed,
    color: frontmatter[1].match(/^color:\s*['"]?(#[0-9a-fA-F]{6})['"]?\s*$/m)?.[1]?.toLowerCase() || '',
    frequency: frontmatter[1].match(/^frequency:\s*(.*)$/m)?.[1]?.trim() || 'daily'
  };
}

const PROTOCOL_CATEGORIES = ['peptide', 'supplement', 'bioregulator', 'prescription'];
const PROTOCOL_TIMES = ['waking', 'breakfast', 'afternoon', 'bedtime'];
const PROTOCOL_WEEKDAYS = [
  { key: 'mon', aliases: ['mon', 'monday'], label: 'Monday', short: 'Mon', day: 1 },
  { key: 'tue', aliases: ['tue', 'tues', 'tuesday'], label: 'Tuesday', short: 'Tue', day: 2 },
  { key: 'wed', aliases: ['wed', 'weds', 'wednesday'], label: 'Wednesday', short: 'Wed', day: 3 },
  { key: 'thu', aliases: ['thu', 'thur', 'thurs', 'thursday'], label: 'Thursday', short: 'Thu', day: 4 },
  { key: 'fri', aliases: ['fri', 'friday'], label: 'Friday', short: 'Fri', day: 5 },
  { key: 'sat', aliases: ['sat', 'saturday'], label: 'Saturday', short: 'Sat', day: 6 },
  { key: 'sun', aliases: ['sun', 'sunday'], label: 'Sunday', short: 'Sun', day: 0 }
];

function normalizeProtocolFrequency(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'daily' || text === 'day' || text === 'every day') return 'daily';
  if (text === 'weekdays' || text === 'weekday' || text === 'monday-friday') return 'weekdays';
  if (text === 'weekly' || text === 'week') return 'weekly';
  const selected = PROTOCOL_WEEKDAYS.filter((weekday) => weekday.aliases.some((alias) => new RegExp(`\\b${alias}\\b`).test(text))).map((weekday) => weekday.key);
  return selected.length ? `days:${selected.join(',')}` : '';
}

function protocolFrequencyLabel(value, short = false) {
  const normalized = normalizeProtocolFrequency(value);
  if (normalized === 'daily') return 'Daily';
  if (normalized === 'weekdays') return 'Weekdays';
  if (normalized === 'weekly') return 'Weekly';
  if (normalized?.startsWith('days:')) {
    const keys = normalized.slice(5).split(',');
    return PROTOCOL_WEEKDAYS.filter((weekday) => keys.includes(weekday.key)).map((weekday) => short ? weekday.short : weekday.label).join(', ');
  }
  return String(value || '');
}

function protocolFrequencyMatchesDate(value, date, cycleStartDate = '') {
  const frequency = normalizeProtocolFrequency(value);
  const day = new Date(`${date}T12:00:00`).getDay();
  if (frequency === 'weekdays') return day >= 1 && day <= 5;
  if (frequency === 'weekly' && cycleStartDate) {
    const days = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${cycleStartDate}T12:00:00Z`)) / 86400000;
    return days >= 0 && days % 7 === 0;
  }
  if (!frequency?.startsWith('days:')) return true;
  return PROTOCOL_WEEKDAYS.some((weekday) => weekday.day === day && frequency.slice(5).split(',').includes(weekday.key));
}

function frontmatterValue(meta, keys) {
  for (const key of keys) {
    const value = meta.match(new RegExp(`^${key}:[ \\t]*(.*(?:\\r?\\n(?:[ \\t]+-.*)*)?)$`, 'im'))?.[1] || '';
    if (value.trim()) return value.replace(/^\s*[-\[\]]+|[\[\]]+\s*$/g, ' ').replace(/["']/g, '').trim();
  }
  return '';
}

function normalizeProtocolCategory(value) {
  const text = String(value || '').toLowerCase();
  if (/peptide/.test(text)) return 'peptide';
  if (/supplement|vitamin|mineral/.test(text)) return 'supplement';
  if (/bioregulator|bio.?regulator/.test(text)) return 'bioregulator';
  if (/prescription|prescribed|medication|medicine/.test(text)) return 'prescription';
  return '';
}

function normalizeProtocolTime(value) {
  const text = String(value || '').toLowerCase();
  if (/waking|wake|upon waking|morning|fasted/.test(text)) return 'waking';
  if (/breakfast|with food.*morning|morning meal/.test(text)) return 'breakfast';
  if (/afternoon|midday|mid-day|lunch/.test(text)) return 'afternoon';
  if (/bedtime|before bed|night|evening/.test(text)) return 'bedtime';
  return '';
}

function protocolCategoryFromPath(filePath) {
  const parts = filePath.split(/[\\/]/).map((part) => part.toLowerCase());
  if (parts.some((part) => /peptides?/.test(part))) return 'peptide';
  if (parts.some((part) => /supplements?/.test(part))) return 'supplement';
  if (parts.some((part) => /bioregulators?/.test(part))) return 'bioregulator';
  if (parts.some((part) => /prescriptions?|medications?/.test(part))) return 'prescription';
  return '';
}

function yamlList(meta, key) {
  const inline = meta.match(new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, 'im'))?.[1];
  if (inline !== undefined) return inline.split(',').map((value) => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const match = meta.match(new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-.*(?:\\r?\\n|$))*)`, 'im'));
  return match?.[1] ? match[1].split(/\r?\n/).map((line) => line.match(/^\s+-\s*["']?([^"']+?)["']?\s*$/)?.[1]).filter(Boolean) : [];
}

function parseProtocolItem(filePath, content, root) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const meta = frontmatter?.[1] || '';
  const declaredType = frontmatterValue(meta, ['type']).toLowerCase();
  const explicitCategory = normalizeProtocolCategory(frontmatterValue(meta, ['category', 'protocol_type', 'item_type', 'substance_type', 'kind', 'class', 'type', 'tags'])) || protocolCategoryFromPath(filePath);
  const tags = [...yamlList(meta, 'tags'), frontmatterValue(meta, ['tags'])].join(' ').toLowerCase();
  const markedAsProtocol = /^(?:protocol|wellness-protocol|wellness_item|wellness item)$/.test(declaredType)
    || /^(?:true|yes)$/i.test(frontmatterValue(meta, ['protocol']))
    || /wellness-item/.test(tags);
  const namedByCategory = PROTOCOL_CATEGORIES.some((category) => new RegExp(`\\b${category}\\b`, 'i').test(path.basename(filePath, path.extname(filePath))));
  if (!markedAsProtocol && !explicitCategory && !namedByCategory) {
    return null;
  }
  const name = path.basename(filePath, path.extname(filePath));
  const categoryText = frontmatterValue(meta, ['category', 'protocol_type', 'item_type', 'substance_type', 'kind', 'class', 'type', 'tags']);
  const timingText = [...yamlList(meta, 'timing'), frontmatterValue(meta, ['timing', 'dose_time', 'time', 'time_of_day', 'when', 'schedule', 'routine', 'phase', 'period'])].join(' ');
  const protocolMonths = yamlList(meta, 'protocol');
  const completedMatch = meta.match(/^completed:[ \t]*(?:\r?\n((?:[ \t]+-\s*.*(?:\r?\n|$))*))?/m);
  const inlineCompleted = meta.match(/^completed:\s*\[([^\]]*)\]\s*$/m)?.[1];
  const completed = inlineCompleted?.trim()
    ? inlineCompleted.split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    : completedMatch?.[1]
      ? completedMatch[1].split(/\r?\n/).map((line) => line.match(/^\s+-\s*["']?([^"']+?)["']?\s*$/)?.[1]).filter(Boolean)
      : [];
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  const description = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) || '';
  return {
    name,
    description,
    category: normalizeProtocolCategory(categoryText) || protocolCategoryFromPath(filePath) || (PROTOCOL_CATEGORIES.find((category) => new RegExp(`\\b${category}\\b`, 'i').test(name)) || ''),
    timing: normalizeProtocolTime(timingText),
    protocolMonths,
    dose: frontmatterValue(meta, ['dose']),
    route: frontmatterValue(meta, ['route']),
    frequency: yamlList(meta, 'frequency').join(', ') || frontmatterValue(meta, ['frequency']),
    itemType: frontmatterValue(meta, ['type']),
    core: frontmatterValue(meta, ['core']),
    product: frontmatterValue(meta, ['product']),
    pairedWith: frontmatterValue(meta, ['paired_with']),
    bloodMarkers: yamlList(meta, 'blood_markers'),
    relativePath: path.relative(root, filePath).split(path.sep).join('/'),
    completed
  };
}

function isHabitFrontmatter(meta) {
  return /^type:\s*habit\s*$/m.test(meta) || /^habit:\s*(?:true|yes)\s*$/mi.test(meta);
}

async function walkMarkdown(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return []; }
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) files.push(...await walkMarkdown(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(full);
  }
  return files;
}

async function walkMarkdownRoots(roots) {
  const files = (await Promise.all(roots.map((root) => walkMarkdown(root)))).flat();
  const seen = new Set();
  const unique = [];
  for (const file of files) {
    let identity = path.resolve(file);
    try { identity = await fs.realpath(file); } catch {}
    if (process.platform === 'darwin' || process.platform === 'win32') identity = identity.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(file);
  }
  return unique;
}

async function resolveWellnessRoot(config) {
  const configured = path.join(config.vaultPath, safeRelative(config.wellnessFolder || 'Wellness', ''));
  if ((await walkMarkdown(configured)).length) return configured;
  const targetName = path.basename(config.wellnessFolder || 'Wellness').toLowerCase();
  const candidates = [];
  async function findDirectories(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.name.toLowerCase() === targetName) candidates.push(full);
      await findDirectories(full);
    }
  }
  await findDirectories(config.vaultPath);
  const scored = [];
  for (const candidate of candidates) {
    const files = await walkMarkdown(candidate);
    let score = files.length ? 1 : 0;
    const childNames = (await fs.readdir(candidate, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase());
    if (childNames.some((name) => /peptides?|supplements?|bioregulators?|prescriptions?|protocols?/.test(name))) score += 10;
    if (files.some((file) => /^protocol\s+\d{4}-\d{2}\.md$/i.test(path.basename(file)))) score += 20;
    scored.push({ candidate, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score ? scored[0].candidate : configured;
}

async function dayPath(date) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  let dailySettings = {};
  try {
    dailySettings = JSON.parse(await fs.readFile(path.join(config.vaultPath, '.obsidian', 'daily-notes.json'), 'utf8'));
  } catch { /* Use Daybook's folder and ISO date defaults if Obsidian settings are unavailable. */ }
  const folder = typeof dailySettings.folder === 'string' ? dailySettings.folder : config.dailyFolder;
  const format = typeof dailySettings.format === 'string' && dailySettings.format ? dailySettings.format : 'YYYY-MM-DD';
  const relative = safeRelative(folder, `${formatDailyNoteName(date, format)}.md`);
  return { config, full: path.join(config.vaultPath, relative), relative: relative.split(path.sep).join('/') };
}

async function handleGetDay(date) {
  const { config, full, relative } = await dayPath(date);
  let content = '';
  try { content = await fs.readFile(full, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const dayBlock = content.match(/<!-- daybook:start -->[\s\S]*?<!-- daybook:end -->/)?.[0] || '';
  const day = parseDayBlock(content);
  const log = logSectionLines(content);
  const parsedLog = parseLogEntries(log.body);
  const today = date.replace(/-/g, '');
  const todayEntries = parsedLog.entries.filter((entry) => entry.timestamp.startsWith(today));
  day.journalEntries = todayEntries.map((entry) => ({ timestamp: entry.timestamp, text: entry.text.trim(), tags: entry.tags || [], context: entry.context || [] }));
  const todayEntry = todayEntries.at(-1);
  if (todayEntry) {
    day.journal = todayEntry.text.trim();
    day.journalTimestamp = todayEntry.timestamp;
  } else if (parsedLog.legacy) {
    day.journal = parsedLog.legacy;
    day.journalTimestamp = '';
    day.journalEntries.push({ timestamp: '', text: parsedLog.legacy });
  } else {
    day.journalTimestamp = '';
  }
  if (day.imagePath) {
    try {
      const imageRelative = safeRelative('', day.imagePath);
      const imageFull = path.join(config.vaultPath, imageRelative);
      await fs.access(imageFull);
      day.imageUrl = pathToFileURL(imageFull).href;
    } catch {
      day.imageUrl = '';
    }
  }
  return { date, relativePath: relative, exists: Boolean(content), hasBlock: Boolean(dayBlock), block: dayBlock, day };
}

const DAY_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.tif', '.tiff', '.avif']);

async function saveDayImage(date, sourcePath) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const extension = path.extname(sourcePath).toLowerCase();
  if (!DAY_IMAGE_EXTENSIONS.has(extension)) throw new Error('Choose a JPG, PNG, GIF, WebP, HEIC, TIFF, or AVIF image.');
  const folder = config.attachmentsFolder || 'Attachments';
  const relative = safeRelative(folder, `${date}${extension}`);
  const full = path.join(config.vaultPath, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  if (path.resolve(sourcePath) !== path.resolve(full)) await fs.copyFile(sourcePath, full);
  return { imagePath: relative.split(path.sep).join('/'), imageUrl: pathToFileURL(full).href };
}

async function chooseDayImage(date) {
  ensureDate(date);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: [...DAY_IMAGE_EXTENSIONS].map((extension) => extension.slice(1)) }]
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return saveDayImage(date, result.filePaths[0]);
}

async function importSelectedPhoto(date) {
  ensureDate(date);
  if (process.platform !== 'darwin') throw new Error('Photos library selection is available on macOS. Use Upload image on this device.');
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'daybook-photo-'));
  const script = `on run argv
  set outputFolder to POSIX file (item 1 of argv)
  tell application "Photos"
    set selectedPhotos to selection
    if (count of selectedPhotos) is 0 then return "NO_SELECTION"
    if (count of selectedPhotos) is not 1 then error "Select one photo in Photos, then try again."
    export selectedPhotos to outputFolder
  end tell
  return "EXPORTED"
end run`;
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script, tempDirectory], { timeout: 120000 });
    if (stdout.trim() === 'NO_SELECTION') {
      await execFileAsync('/usr/bin/open', ['-a', 'Photos']);
      return { needsSelection: true };
    }
    const files = (await fs.readdir(tempDirectory)).filter((file) => DAY_IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));
    if (!files.length) throw new Error('Photos did not export a supported image. Try Upload image instead.');
    return await saveDayImage(date, path.join(tempDirectory, files[0]));
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function calendarBridgeExecutable() {
  const source = path.join(__dirname, 'calendar-bridge.swift');
  const bundle = path.join(app.getPath('userData'), 'CalendarBridge.app');
  const contents = path.join(bundle, 'Contents');
  const executable = path.join(contents, 'MacOS', 'CalendarBridge');
  const infoPlist = path.join(contents, 'Info.plist');
  const sourceInfo = await fs.stat(source);
  let currentInfo = null;
  try { currentInfo = await fs.stat(executable); } catch {}
  let plistExists = true;
  try { await fs.access(infoPlist); } catch { plistExists = false; }
  const rebuild = !currentInfo || !plistExists || sourceInfo.mtimeMs > currentInfo.mtimeMs;
  if (rebuild) {
    await fs.mkdir(path.dirname(executable), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>CalendarBridge</string>
  <key>CFBundleIdentifier</key><string>com.daybook.app.calendarbridge</string>
  <key>CFBundleName</key><string>Daybook</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCalendarsFullAccessUsageDescription</key><string>Daybook reads your calendar events for your schedule and adds meetings you create.</string>
  <key>NSCalendarsUsageDescription</key><string>Daybook reads your calendar events for your schedule and adds meetings you create.</string>
</dict></plist>`;
    await fs.writeFile(infoPlist, plist, 'utf8');
    let buildDirectory = '';
    try {
      buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'daybook-calendar-bridge-'));
      const moduleCache = path.join(buildDirectory, 'ModuleCache');
      const stagedExecutable = path.join(buildDirectory, 'CalendarBridge');
      const bundleStagingExecutable = `${executable}.new-${process.pid}`;
      await fs.mkdir(moduleCache, { recursive: true });
      await execFileAsync('/usr/bin/swiftc', ['-parse-as-library', '-module-cache-path', moduleCache, source, '-framework', 'EventKit', '-framework', 'Foundation', '-o', stagedExecutable], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
      await fs.copyFile(stagedExecutable, bundleStagingExecutable);
      await fs.chmod(bundleStagingExecutable, 0o755);
      await fs.rename(bundleStagingExecutable, executable);
      await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.daybook.app.calendarbridge', bundle], { timeout: 30000 });
    } catch (error) {
      await fs.rm(bundle, { recursive: true, force: true });
      const detail = String(error.stderr || error.message || '').trim();
      throw new Error(`Daybook could not prepare its native Calendar connection. ${detail || 'The native Calendar bridge could not be built or installed.'}`.trim());
    } finally {
      if (buildDirectory) await fs.rm(buildDirectory, { recursive: true, force: true });
    }
  }
  return executable;
}

async function callCalendarBridge(command, ...args) {
  const executable = await calendarBridgeExecutable();
  const { stdout } = await execFileAsync(executable, [command, ...args], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error('Daybook could not read the response from macOS Calendar.'); }
  if (result.error) throw new Error(result.error);
  return result;
}

async function handleRequestCalendarAccess() {
  if (process.platform !== 'darwin') return { supported: false, authorized: false };
  const result = await callCalendarBridge('request');
  return { supported: true, authorized: Boolean(result.authorized) };
}

async function handleGetCalendarEvents(date) {
  if (process.platform !== 'darwin') return { supported: false, events: [] };
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a valid calendar date.');
  const result = await callCalendarBridge('list', date);
  const events = Array.isArray(result.events) ? result.events : [];
  return { supported: true, authorized: Boolean(result.authorized), events };
}

async function handleGetCalendarMonth(month) {
  if (process.platform !== 'darwin') return { supported: false, events: [] };
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new Error('Choose a valid calendar month.');
  const result = await callCalendarBridge('list-month', month);
  const events = Array.isArray(result.events) ? result.events : [];
  return { supported: true, authorized: Boolean(result.authorized), events };
}

async function handleCreateCalendarMeeting(input) {
  if (process.platform !== 'darwin') throw new Error('Creating a calendar meeting is available on macOS.');
  const config = await readConfig();
  ensureConfigured(config);
  if (!input || typeof input !== 'object') throw new Error('Enter meeting details first.');
  const title = String(input.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 200);
  if (!title) throw new Error('Enter a meeting title.');
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error('Choose a valid start and end time.');
  const payload = {
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    location: String(input.location || '').trim().slice(0, 500),
    agenda: String(input.agenda || '').trim().slice(0, 5000),
    url: String(input.url || '').trim().slice(0, 2000)
  };
  const meetingType = ['One on One', 'Project Meeting', 'Vendor Meeting', 'Other Meeting'].includes(input.meetingType) ? input.meetingType : 'Other Meeting';
  const people = Array.isArray(input.people) ? input.people.slice(0, 50).map((item) => String(item).trim()).filter(Boolean) : [];
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const result = await callCalendarBridge('create', encoded);
  if (!result.authorized) throw new Error(result.error || 'Calendar access is unavailable.');
  if (!result.event) throw new Error(result.error || 'Calendar did not save the meeting.');
  return handleCreateMeetingNote({ ...result.event, agenda: payload.agenda, meetingType, people });
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function yamlObjectLines(object, indent = 0) {
  const lines = [];
  const padding = ' '.repeat(indent);
  for (const [key, value] of Object.entries(object)) {
    if (Array.isArray(value)) {
      if (!value.length) { lines.push(`${padding}${key}: []`); continue; }
      lines.push(`${padding}${key}:`);
      for (const item of value) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          lines.push(`${' '.repeat(indent + 2)}-`);
          lines.push(...yamlObjectLines(item, indent + 4));
        } else {
          lines.push(`${' '.repeat(indent + 2)}- ${yamlScalar(item)}`);
        }
      }
    } else if (value && typeof value === 'object') {
      if (Object.keys(value).length === 0) lines.push(`${padding}${key}: {}`);
      else {
        lines.push(`${padding}${key}:`);
        lines.push(...yamlObjectLines(value, indent + 2));
      }
    } else {
      lines.push(`${padding}${key}: ${yamlScalar(value)}`);
    }
  }
  return lines;
}

async function handleCreateMeetingNote(sourceEvent) {
  const config = await readConfig();
  ensureConfigured(config);
  if (!sourceEvent || typeof sourceEvent !== 'object') throw new Error('Choose a calendar event first.');
  const start = new Date(sourceEvent.start);
  const end = new Date(sourceEvent.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('This calendar event has an invalid date or time.');
  const pad = (value) => String(value).padStart(2, '0');
  const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const title = String(sourceEvent.title || 'Untitled meeting').trim().replace(/[\r\n]+/g, ' ').slice(0, 200) || 'Untitled meeting';
  const metadata = {
    title,
    start: sourceEvent.start,
    end: sourceEvent.end,
    all_day: Boolean(sourceEvent.allDay),
    calendar: String(sourceEvent.calendar || ''),
    calendar_identifier: String(sourceEvent.calendarIdentifier || ''),
    calendar_type: String(sourceEvent.calendarType || ''),
    calendar_source: String(sourceEvent.calendarSource || ''),
    event_identifier: String(sourceEvent.eventIdentifier || ''),
    calendar_item_identifier: String(sourceEvent.calendarItemIdentifier || ''),
    calendar_item_external_identifier: String(sourceEvent.calendarItemExternalIdentifier || ''),
    location: String(sourceEvent.location || ''),
    notes: String(sourceEvent.notes || ''),
    url: String(sourceEvent.url || ''),
    created_at: String(sourceEvent.createdAt || ''),
    updated_at: String(sourceEvent.updatedAt || ''),
    time_zone: String(sourceEvent.timeZone || ''),
    attendees: Array.isArray(sourceEvent.attendees) ? sourceEvent.attendees : [],
    organizer: sourceEvent.organizer && typeof sourceEvent.organizer === 'object' ? sourceEvent.organizer : {},
    availability: String(sourceEvent.availability || ''),
    status: String(sourceEvent.status || ''),
    occurrence_date: String(sourceEvent.occurrenceDate || ''),
    is_detached: Boolean(sourceEvent.isDetached),
    alarms: Array.isArray(sourceEvent.alarms) ? sourceEvent.alarms : [],
    recurrence_rules: Array.isArray(sourceEvent.recurrenceRules) ? sourceEvent.recurrenceRules : []
  };
  const filenameTitle = title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  const folder = configuredFolderPath(config, 'meetingsFolder', 'MEETINGS');
  await fs.mkdir(folder, { recursive: true });
  const eventIdentifierLine = `event_identifier: ${yamlScalar(metadata.event_identifier)}`;
  let full = path.join(folder, `${date} - ${filenameTitle}.md`);
  let suffix = 2;
  while (true) {
    try {
      const existing = await fs.readFile(full, 'utf8');
      if (metadata.event_identifier && existing.includes(eventIdentifierLine)) {
        return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), alreadyExisted: true };
      }
      full = path.join(folder, `${date} - ${filenameTitle} (${suffix++}).md`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  const meetingType = ['One on One', 'Project Meeting', 'Vendor Meeting', 'Other Meeting'].includes(sourceEvent.meetingType) ? sourceEvent.meetingType : 'Other Meeting';
  const people = Array.isArray(sourceEvent.people) ? sourceEvent.people.slice(0, 50).map((item) => String(item).trim()).filter(Boolean) : [];
  const personLinks = people.map((person) => `[[${person.replace(/\.md$/i, '')}]]`);
  const frontmatter = ['---', 'type: meeting', `meeting_type: ${yamlScalar(meetingType)}`, ...(personLinks.length ? ['people:', ...personLinks.map((person) => `  - ${yamlScalar(person)}`)] : ['people: []']), 'tags:', '  - meeting', 'calendar_event:', ...yamlObjectLines(metadata, 2), '---'].join('\n');
  const agenda = String(sourceEvent.agenda || '').trim();
  const content = `${frontmatter}\n\n# ${title}\n\n## Agenda\n\n${agenda ? `${agenda}\n\n` : ''}## Notes\n\n## Action Items\n\n`;
  await fs.writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
  return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), alreadyExisted: false };
}

async function handleListMeetingNotes() {
  const config = await readConfig();
  ensureConfigured(config);
  const folders = configuredFolderRoots(config, 'meetingsFolder', 'MEETINGS', 'Meetings');
  const files = await walkMarkdownRoots(folders);
  const notes = [];
  for (const full of files) {
    const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)]);
    const relativePath = path.relative(config.vaultPath, full).split(path.sep).join('/');
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
    const heading = content.match(/^#\s+(.+?)\s*$/m)?.[1];
    const fileDate = path.basename(full).match(/^(\d{4}-\d{2}-\d{2})\s+-/)?.[1] || '';
    const meetingType = meetingYamlScalar(frontmatter.match(/^meeting_type:\s*(.*)$/m)?.[1] || 'Other Meeting');
    notes.push({
      relativePath,
      title: heading || path.basename(full, path.extname(full)),
      date: fileDate,
      starred: /^starred:\s*(?:true|yes|1)\s*$/im.test(frontmatter),
      meetingType,
      people: meetingFrontmatterSection(frontmatter, 'people').map((line) => meetingYamlScalar(line.replace(/^\s*-\s*/, ''))),
      updatedAt: stat.mtime.toISOString()
    });
  }
  return notes.sort((a, b) => Date.parse(b.date || b.updatedAt) - Date.parse(a.date || a.updatedAt) || a.title.localeCompare(b.title));
}

function setMeetingStarred(content, starred) {
  const match = content.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!match) return `---\nstarred: ${starred}\n---\n\n${content}`;
  const frontmatter = match[2];
  const nextFrontmatter = /^starred:\s*.*$/im.test(frontmatter)
    ? frontmatter.replace(/^starred:\s*.*$/im, `starred: ${starred}`)
    : `${frontmatter}\nstarred: ${starred}`;
  return `${match[1]}${nextFrontmatter}${match[3]}${content.slice(match[0].length)}`;
}

async function handleSetMeetingStarred(relativePath, starred) {
  const config = await readConfig();
  ensureConfigured(config);
  const full = resolveMeetingNotePath(config, relativePath);
  const content = await fs.readFile(full, 'utf8');
  await fs.writeFile(full, setMeetingStarred(content, Boolean(starred)), 'utf8');
  return { starred: Boolean(starred) };
}

function resolveMeetingNotePath(config, relativePath) {
  const full = path.resolve(config.vaultPath, String(relativePath || '').split('/').join(path.sep));
  const insideFolder = configuredFolderRoots(config, 'meetingsFolder', 'MEETINGS', 'Meetings').some((root) => {
    const relative = path.relative(path.resolve(root), full);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!insideFolder || !full.toLowerCase().endsWith('.md')) throw new Error('Choose a meeting note inside the configured Meetings folder.');
  return full;
}

function projectFrontmatter(content) {
  return content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
}

function projectValue(frontmatter, key) {
  const line = frontmatter.split(/\r?\n/).find((entry) => new RegExp(`^${key}:\\s*`).test(entry));
  if (!line) return '';
  const value = line.replace(new RegExp(`^${key}:\\s*`), '').trim();
  try { return JSON.parse(value); } catch { return value.replace(/^['"]|['"]$/g, ''); }
}

function projectSection(body, name) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function replaceProjectSection(body, name, value) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  const section = [`## ${name}`, ...(value.trim() ? ['', value.trim()] : [''])];
  if (start < 0) return `${body.trimEnd()}${body.trim() ? '\n\n' : ''}${section.join('\n')}\n`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break; }
  }
  return [...lines.slice(0, start), ...section, ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function resolveProjectPath(config, relativePath) {
  const full = path.resolve(config.vaultPath, String(relativePath || '').split('/').join(path.sep));
  const insideFolder = configuredFolderRoots(config, 'projectsFolder', 'PROJECTS', 'Projects').some((root) => {
    const relative = path.relative(path.resolve(root), full);
    return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  if (!insideFolder || !full.toLowerCase().endsWith('.md')) throw new Error('Choose a project note inside the configured Projects folder.');
  return full;
}

async function handleListProjects() {
  const config = await readConfig();
  ensureConfigured(config);
  const folders = configuredFolderRoots(config, 'projectsFolder', 'PROJECTS', 'Projects');
  const files = await walkMarkdownRoots(folders);
  const projects = [];
  for (const full of files) {
    const content = await fs.readFile(full, 'utf8');
    const frontmatter = projectFrontmatter(content);
    if (projectValue(frontmatter, 'daybook_project') !== true) continue;
    let taskLinks = [];
    try {
      const value = projectValue(frontmatter, 'daybook_task_links');
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (Array.isArray(parsed)) taskLinks = parsed;
    } catch {}
    let people = [];
    try {
      const value = projectValue(frontmatter, 'daybook_people');
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (Array.isArray(parsed)) people = parsed;
    } catch {}
    const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const title = content.match(/^#\s+(.+?)\s*$/m)?.[1] || path.basename(full, '.md');
    const milestones = projectSection(body, 'Milestones').split(/\r?\n/).map((line) => line.match(/^\s*- \[(x| )\]\s+(.+)$/i)).filter(Boolean).map((match) => ({ done: match[1].toLowerCase() === 'x', text: match[2] }));
    const stat = await fs.stat(full);
    projects.push({
      relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), title,
      status: projectValue(frontmatter, 'status') || 'active',
      priority: projectValue(frontmatter, 'priority') || 'normal',
      startDate: projectValue(frontmatter, 'start_date'), dueDate: projectValue(frontmatter, 'due_date'),
      taskLinks, people,
      overview: projectSection(body, 'Overview'), milestones,
      updatedAt: stat.mtime.toISOString()
    });
  }
  const order = { active: 0, paused: 1, completed: 2, archived: 3 };
  return projects.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4) || (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') || a.title.localeCompare(b.title));
}

async function handleListPeople() {
  const config = await readConfig();
  ensureConfigured(config);
  const files = await walkMarkdownRoots(configuredFolderRoots(config, 'peopleFolder', 'People'));
  const people = [];
  for (const full of files) {
    const content = await fs.readFile(full, 'utf8');
    const title = content.match(/^#\s+(.+?)\s*$/m)?.[1] || path.basename(full, '.md');
    const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
    const scalar = (key) => {
      const value = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1] || '';
      return meetingYamlScalar(value);
    };
    const role = scalar('role');
    const organization = scalar('organization');
    let taskLinks = [];
    try { const value = scalar('daybook_task_links'); const parsed = typeof value === 'string' ? JSON.parse(value) : value; if (Array.isArray(parsed)) taskLinks = parsed; } catch {}
    people.push({ relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), title, role, organization, taskLinks });
  }
  return people.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
}

async function handleSetTaskPeople(taskKey, selectedPeople = []) {
  const config = await readConfig();
  ensureConfigured(config);
  const key = String(taskKey || '').trim().slice(0, 2500);
  if (!key) throw new Error('Could not identify this task. Refresh Tasks and try again.');
  const roots = configuredFolderRoots(config, 'peopleFolder', 'People');
  const files = await walkMarkdownRoots(roots);
  const wanted = new Set(Array.isArray(selectedPeople) ? selectedPeople.map((value) => String(value)) : []);
  const fileByRelative = new Map(files.map((full) => [path.relative(config.vaultPath, full).split(path.sep).join('/'), full]));
  for (const relativePath of wanted) {
    if (!fileByRelative.has(relativePath)) throw new Error('Choose people notes from your configured People folder.');
  }
  for (const [relativePath, full] of fileByRelative) {
    const content = await fs.readFile(full, 'utf8');
    const match = content.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    if (!match) {
      if (wanted.has(relativePath)) {
        const frontmatter = `---\ntype: person\ndaybook_task_links: ${JSON.stringify([key])}\n---\n\n`;
        await fs.writeFile(full, `${frontmatter}${content}`, 'utf8');
      }
      continue;
    }
    const frontmatter = match[2];
    let links = [];
    const raw = frontmatter.match(/^daybook_task_links:\s*(.*)$/m)?.[1] || '';
    try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) links = parsed.map(String); } catch {}
    const shouldHave = wanted.has(relativePath);
    const next = [...new Set([...links.filter((entry) => entry !== key), ...(shouldHave ? [key] : [])])];
    if (next.length === links.length && next.every((entry, index) => entry === links[index])) continue;
    const property = `daybook_task_links: ${JSON.stringify(next)}`;
    const updatedFrontmatter = /^daybook_task_links:\s*.*$/m.test(frontmatter)
      ? frontmatter.replace(/^daybook_task_links:\s*.*$/m, property)
      : `${frontmatter}\n${property}`;
    await fs.writeFile(full, `${match[1]}${updatedFrontmatter}${match[3]}${content.slice(match[0].length)}`, 'utf8');
  }
  return { saved: true, people: [...wanted] };
}

async function handleCreatePerson(input = {}) {
  const config = await readConfig();
  ensureConfigured(config);
  const title = String(input.name || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
  if (!title) throw new Error('Enter a person’s name.');
  const folder = configuredFolderPath(config, 'peopleFolder', 'People');
  await fs.mkdir(folder, { recursive: true });
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
  let full = path.join(folder, `${safeTitle}.md`);
  let suffix = 2;
  while (true) {
    try {
      const content = await fs.readFile(full, 'utf8');
      if (content.match(/^#\s+(.+?)\s*$/m)?.[1]?.toLowerCase() === title.toLowerCase()) {
        return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), alreadyExisted: true };
      }
      full = path.join(folder, `${safeTitle} (${suffix++}).md`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  const role = String(input.role || '').trim().slice(0, 200);
  const organization = String(input.organization || '').trim().slice(0, 200);
  const frontmatter = ['---', 'type: person', 'tags:', '  - person', `role: ${yamlScalar(role)}`, `organization: ${yamlScalar(organization)}`, '---'].join('\n');
  await fs.writeFile(full, `${frontmatter}\n\n# ${title}\n\n## Notes\n\n`, { encoding: 'utf8', flag: 'wx' });
  return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), alreadyExisted: false };
}

async function handleSaveProject(projectInput = {}) {
  const config = await readConfig();
  ensureConfigured(config);
  const title = String(projectInput.title || '').trim().replace(/[\r\n]+/g, ' ').slice(0, 120);
  if (!title) throw new Error('Give this project a name.');
  const statuses = new Set(['active', 'paused', 'completed', 'archived']);
  const priorities = new Set(['low', 'normal', 'high']);
  const status = statuses.has(projectInput.status) ? projectInput.status : 'active';
  const priority = priorities.has(projectInput.priority) ? projectInput.priority : 'normal';
  const startDate = String(projectInput.startDate || '');
  const dueDate = String(projectInput.dueDate || '');
  if (startDate) ensureDate(startDate);
  if (dueDate) ensureDate(dueDate);
  const taskLinks = Array.isArray(projectInput.taskLinks) ? projectInput.taskLinks.slice(0, 500).filter((link) => {
    return link && ['todoist', 'obsidian', 'reminder'].includes(link.source)
      && (link.source === 'obsidian' ? link.relativePath && link.text : link.id);
  }).map((link) => ({
    source: link.source,
    ...(link.source === 'obsidian' ? { relativePath: String(link.relativePath).slice(0, 1000), text: String(link.text).slice(0, 1000) } : { id: String(link.id).slice(0, 200) }),
    title: String(link.title || '').slice(0, 500)
  })) : [];
  const people = Array.isArray(projectInput.people) ? projectInput.people.slice(0, 100).map((person) => String(person).slice(0, 1000)) : [];
  const overview = String(projectInput.overview || '').trim().slice(0, 10000);
  const milestones = String(projectInput.milestones || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^[-*]?\s*\[([ xX])\]\s*(.*)$/);
    return match ? `- [${match[1].toLowerCase()}] ${match[2]}` : `- [ ] ${line.replace(/^[-*]\s*/, '')}`;
  }).join('\n');
  const folder = configuredFolderPath(config, 'projectsFolder', 'PROJECTS');
  await fs.mkdir(folder, { recursive: true });
  let full;
  let body;
  if (projectInput.relativePath) {
    full = resolveProjectPath(config, projectInput.relativePath);
    const existing = await fs.readFile(full, 'utf8');
    if (projectValue(projectFrontmatter(existing), 'daybook_project') !== true) throw new Error('This note is no longer a Daybook project.');
    body = existing.replace(/^---\s*\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  } else {
    const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'project';
    full = path.join(folder, `${slug}.md`);
    let suffix = 2;
    while (true) {
      try { await fs.access(full); full = path.join(folder, `${slug}-${suffix++}.md`); }
      catch { break; }
    }
    body = '';
  }
  const fields = {
    daybook_project: true, status, priority,
    start_date: startDate || null, due_date: dueDate || null,
    daybook_task_links: JSON.stringify(taskLinks), daybook_people: JSON.stringify(people)
  };
  const fm = ['---', ...yamlObjectLines(fields), '---'].join('\n');
  let updatedBody = body.replace(/^#\s+.+(?:\r?\n|$)/m, '').trimStart();
  if (!body.match(/^#\s+.+$/m)) updatedBody = updatedBody.trimStart();
  updatedBody = `# ${title}\n\n${updatedBody}`;
  updatedBody = replaceProjectSection(updatedBody, 'Overview', overview);
  updatedBody = replaceProjectSection(updatedBody, 'Milestones', milestones);
  await fs.writeFile(full, `${fm}\n\n${updatedBody.trim()}\n`, 'utf8');
  return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), title };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm'));
  if (!match) return '';
  try { return JSON.parse(match[1]); } catch { return match[1].replace(/^['"]|['"]$/g, ''); }
}

function meetingFrontmatterSection(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end += 1;
  return lines.slice(start + 1, end);
}

function meetingYamlScalar(value) {
  const text = String(value ?? '').trim();
  try { return JSON.parse(text); } catch { return text.replace(/^['"]|['"]$/g, ''); }
}

function meetingMetadataValue(frontmatter, key) {
  const section = meetingFrontmatterSection(frontmatter, 'calendar_event');
  const row = section.find((line) => new RegExp(`^\\s{2}${key}:\\s*`).test(line));
  return row ? meetingYamlScalar(row.replace(new RegExp(`^\\s{2}${key}:\\s*`), '')) : '';
}

function meetingMetadataObject(frontmatter, key) {
  const section = meetingFrontmatterSection(frontmatter, 'calendar_event');
  const header = section.findIndex((line) => new RegExp(`^\\s{2}${key}:\\s*$`).test(line));
  if (header < 0) return {};
  const values = {};
  for (const line of section.slice(header + 1)) {
    if (!/^\s{4,}/.test(line)) break;
    const match = line.match(/^\s{4,}([\w-]+):\s*(.*)$/);
    if (match) values[match[1]] = meetingYamlScalar(match[2]);
  }
  return values;
}

function meetingMetadataList(frontmatter, key) {
  const section = meetingFrontmatterSection(frontmatter, 'calendar_event');
  const header = section.findIndex((line) => new RegExp(`^\\s{2}${key}:\\s*$`).test(line));
  if (header < 0) return [];
  const values = [];
  let current = null;
  for (const line of section.slice(header + 1)) {
    if (/^\s{2}\w[\w-]*:/.test(line)) break;
    if (/^\s{4}-\s*$/.test(line)) {
      if (current) values.push(current);
      current = {};
      continue;
    }
    const match = line.match(/^\s{6}([\w-]+):\s*(.*)$/);
    if (match && current) current[match[1]] = meetingYamlScalar(match[2]);
  }
  if (current) values.push(current);
  return values;
}

function meetingBodySection(content, title) {
  const headings = [...content.matchAll(/^##\s+(.+?)\s*\r?\n/gm)];
  const index = headings.findIndex((match) => match[1].trim().toLowerCase() === title.toLowerCase());
  if (index < 0) return '';
  const start = headings[index].index + headings[index][0].length;
  const end = headings[index + 1]?.index ?? content.length;
  return content.slice(start, end).replace(/\s+$/, '');
}

function replaceMeetingBodySection(content, title, value) {
  const text = String(value ?? '').replace(/\s+$/, '');
  const headings = [...content.matchAll(/^##\s+(.+?)\s*\r?\n/gm)];
  const index = headings.findIndex((match) => match[1].trim().toLowerCase() === title.toLowerCase());
  if (index >= 0) {
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return `${content.slice(0, start)}${text}${text ? '\n\n' : '\n'}${content.slice(end).replace(/^\r?\n/, '')}`;
  }
  const insertionOrder = ['Agenda', 'Notes', 'Action Items'];
  const currentRank = insertionOrder.indexOf(title);
  const next = headings.find((match) => insertionOrder.indexOf(match[1].trim()) > currentRank);
  const section = `## ${title}\n\n${text}\n\n`;
  if (next) return `${content.slice(0, next.index)}${section}${content.slice(next.index)}`;
  return `${content.replace(/\s*$/, '')}\n\n${section.trimEnd()}\n`;
}

async function handleGetMeetingNote(relativePath) {
  const config = await readConfig();
  ensureConfigured(config);
  const full = resolveMeetingNotePath(config, relativePath);
  const content = await fs.readFile(full, 'utf8');
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const start = meetingMetadataValue(frontmatter, 'start');
  const eventNotes = meetingMetadataValue(frontmatter, 'notes');
  const meetingType = meetingYamlScalar(frontmatter.match(/^meeting_type:\s*(.*)$/m)?.[1] || 'Other Meeting');
  const peopleBlock = frontmatter.match(/^people:\s*\r?\n((?:\s+-.*(?:\r?\n|$))*)/m)?.[1] || '';
  const people = peopleBlock.split(/\r?\n/).map((line) => line.match(/^\s+-\s*(.*)$/)?.[1]).filter(Boolean).map(meetingYamlScalar);
  const url = meetingMetadataValue(frontmatter, 'url');
  const zoomUrl = (/zoom\.(?:us|com)/i.test(url) ? url : (eventNotes.match(/https?:\/\/[^\s<>"']*zoom\.(?:us|com)[^\s<>"']*/i)?.[0] || '')).replace(/[),.;]+$/, '');
  const title = content.match(/^#\s+(.+?)\s*$/m)?.[1] || path.basename(full, path.extname(full));
  const fileDate = path.basename(full).match(/^(\d{4}-\d{2}-\d{2})\s+-/)?.[1] || '';
  return {
    relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'),
    title,
    starred: /^starred:\s*(?:true|yes|1)\s*$/im.test(frontmatter),
    date: fileDate || String(start).slice(0, 10),
    meetingType,
    people,
    start,
    end: meetingMetadataValue(frontmatter, 'end'),
    allDay: Boolean(meetingMetadataValue(frontmatter, 'all_day')),
    calendar: meetingMetadataValue(frontmatter, 'calendar'),
    location: meetingMetadataValue(frontmatter, 'location'),
    url,
    zoomUrl,
    eventNotes,
    attendees: meetingMetadataList(frontmatter, 'attendees'),
    organizer: meetingMetadataObject(frontmatter, 'organizer'),
    agenda: meetingBodySection(content, 'Agenda'),
    notes: meetingBodySection(content, 'Notes'),
    actionItems: meetingBodySection(content, 'Action Items'),
    expectedContent: content
  };
}

async function handleSaveMeetingNote(relativePath, agenda, notes, actionItems, expectedContent) {
  const config = await readConfig();
  ensureConfigured(config);
  const full = resolveMeetingNotePath(config, relativePath);
  const current = await fs.readFile(full, 'utf8');
  if (current !== expectedContent) throw new Error('This meeting note changed outside Daybook. Reload it before saving your notes.');
  let updated = replaceMeetingBodySection(current, 'Agenda', agenda);
  updated = replaceMeetingBodySection(updated, 'Notes', notes);
  updated = replaceMeetingBodySection(updated, 'Action Items', actionItems);
  await fs.writeFile(full, updated, 'utf8');
  return { expectedContent: updated };
}

async function openCalendarPrivacySettings() {
  if (process.platform !== 'darwin') return { supported: false };
  try {
    await shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars');
  } catch {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars');
  }
  return { supported: true };
}

async function handleListReminders() {
  if (process.platform !== 'darwin') return { supported: false, reminders: [] };
  const script = `on run
  set rows to {}
  tell application "Reminders"
    repeat with reminderList in lists
      set listName to name of reminderList as text
      repeat with reminderItem in (every reminder of reminderList whose completed is false)
        set reminderId to id of reminderItem as text
        set reminderTitle to name of reminderItem as text
        set dueText to ""
        set reminderPriority to 0
        try
          set dueText to my isoDate(due date of reminderItem)
        end try
        try
          set reminderPriority to priority of reminderItem as integer
        end try
        set fieldDelimiter to character id 31
        set AppleScript's text item delimiters to fieldDelimiter
        set rowText to {reminderId, reminderTitle, listName, dueText, reminderPriority as text} as text
        set end of rows to rowText
      end repeat
    end repeat
  end tell
  set AppleScript's text item delimiters to (character id 30)
  return rows as text
end run

on pad2(n)
  set t to n as integer as text
  if (count of t) is 1 then return "0" & t
  return t
end pad2

on isoDate(d)
  set y to year of d as integer
  set m to month of d as integer
  set dd to day of d as integer
  set hh to hours of d as integer
  set mm to minutes of d as integer
  return (y as text) & "-" & my pad2(m) & "-" & my pad2(dd) & "T" & my pad2(hh) & ":" & my pad2(mm)
end isoDate`;
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const recordSeparator = String.fromCharCode(30);
  const fieldSeparator = String.fromCharCode(31);
  const reminders = stdout.trim() ? stdout.trim().split(recordSeparator).map((row) => {
    const [id, title, list, dueDate, applePriority] = row.split(fieldSeparator);
    const rawPriority = Number(applePriority || 0);
    const priority = rawPriority === 1 ? 3 : rawPriority === 5 ? 2 : rawPriority === 9 ? 1 : 1;
    return { id, title, list, dueDate: dueDate || '', priority };
  }).filter((reminder) => reminder.id && reminder.title) : [];
  reminders.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title));
  return { supported: true, reminders };
}

async function handleUpdateReminder(id, dueDate, priority) {
  if (process.platform !== 'darwin') throw new Error('Apple Reminders is available on macOS.');
  const cleanDate = String(dueDate || '');
  if (cleanDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Choose a valid due date.');
  const level = Math.min(4, Math.max(1, Number(priority) || 1));
  const script = `on run argv
  set targetId to item 1 of argv
  set dateText to item 2 of argv
  set priorityLevel to item 3 of argv as integer
  tell application "Reminders"
    repeat with reminderList in lists
      repeat with reminderItem in reminders of reminderList
        if (id of reminderItem as text) is targetId then
          if dateText is "" then
            try
              set due date of reminderItem to missing value
            end try
          else
            set yearNumber to (text 1 thru 4 of dateText) as integer
            set monthNumber to (text 6 thru 7 of dateText) as integer
            set dayNumber to (text 9 thru 10 of dateText) as integer
            set monthValues to {January, February, March, April, May, June, July, August, September, October, November, December}
            set dueValue to current date
            set time of dueValue to 43200
            set year of dueValue to yearNumber
            set month of dueValue to item monthNumber of monthValues
            set day of dueValue to dayNumber
            set due date of reminderItem to dueValue
          end if
          if priorityLevel is 1 then
            set priority of reminderItem to 0
          else if priorityLevel is 2 then
            set priority of reminderItem to 5
          else
            set priority of reminderItem to 1
          end if
          return "saved"
        end if
      end repeat
    end repeat
  end tell
  error "This reminder could not be found."
end run`;
  await execFileAsync('/usr/bin/osascript', ['-e', script, String(id), cleanDate, String(level)], { timeout: 30000 });
  return { saved: true };
}

async function handleCreateReminder(title, dueDate = '', priority = 1) {
  if (process.platform !== 'darwin') throw new Error('Apple Reminders is available on macOS.');
  const cleanTitle = String(title || '').trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
  if (!cleanTitle) throw new Error('Enter a reminder first.');
  const cleanDate = String(dueDate || '');
  if (cleanDate) ensureDate(cleanDate);
  const script = `on run argv
  set reminderTitle to item 1 of argv
  tell application "Reminders"
    set targetList to default list
    set newReminder to make new reminder at end of reminders of targetList with properties {name:reminderTitle}
    return id of newReminder as text
  end tell
end run`;
  const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script, cleanTitle], { timeout: 30000 });
  const id = stdout.trim();
  await handleUpdateReminder(id, cleanDate, priority);
  return { created: true, id };
}

async function handleCompleteReminder(id) {
  if (process.platform !== 'darwin') throw new Error('Apple Reminders is available on macOS.');
  const script = `on run argv
  set targetId to item 1 of argv
  tell application "Reminders"
    repeat with reminderList in lists
      repeat with reminderItem in reminders of reminderList
        if (id of reminderItem as text) is targetId then
          set completed of reminderItem to true
          return "done"
        end if
      end repeat
    end repeat
  end tell
  error "That reminder could not be found. Refresh the list and try again."
end run`;
  await execFileAsync('/usr/bin/osascript', ['-e', script, String(id)], { timeout: 30000 });
  return { done: true };
}

async function handleSaveDay(date, day, expectedBlock = '') {
  const { config, full, relative } = await dayPath(date);
  await fs.mkdir(path.dirname(full), { recursive: true });
  let content = '';
  try { content = await fs.readFile(full, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const currentBlock = content.match(/<!-- daybook:start -->[\s\S]*?<!-- daybook:end -->/)?.[0] || '';
  if (currentBlock !== expectedBlock) throw new Error('This daily note changed outside Daybook. Reopen the day to load the latest version before saving.');
  let updated = updateDayBlock(content, day);
  const journalEntries = Array.isArray(day.journalEntries)
    ? day.journalEntries.filter((entry) => entry.timestamp && entry.text?.trim())
    : (day.journalTimestamp && day.journal?.trim() ? [{ timestamp: day.journalTimestamp, text: day.journal }] : []);
  const retained = new Set(journalEntries.map((entry) => entry.timestamp));
  const logSection = logSectionLines(updated);
  if (logSection.heading >= 0) {
    const prefix = date.replace(/-/g, '');
    let body = [...logSection.body];
    for (const entry of parseLogEntries(body).entries) {
      if (entry.timestamp.startsWith(prefix) && !retained.has(entry.timestamp)) body = replaceLogEntry(body, entry.timestamp, '', [], []);
    }
    updated = [...logSection.lines.slice(0, logSection.heading + 1), ...body, ...logSection.lines.slice(logSection.end)].join('\n');
  }
  for (const entry of journalEntries) updated = updateLogSection(updated, entry.text, entry.timestamp, Array.isArray(entry.tags) ? entry.tags : [], Array.isArray(entry.context) ? entry.context : []);
  await fs.writeFile(full, updated, 'utf8');
  const block = updated.match(/<!-- daybook:start -->[\s\S]*?<!-- daybook:end -->/)?.[0] || '';
  return { relativePath: relative, block };
}

async function handleCreateObsidianTaskFromJournal(date, text, tags = [], dueDate = '', priority = null) {
  const { full, relative } = await dayPath(date);
  const title = String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('This journal entry does not contain text to turn into a task.');
  const cleanDate = String(dueDate || '');
  if (cleanDate) ensureDate(cleanDate);
  const priorityMarker = priority === null || priority === undefined ? '' : ` ${{ 1: '➖', 2: '🔼', 3: '⏫', 4: '🔺' }[Math.min(4, Math.max(1, Number(priority) || 1))]}`;
  const dueMarker = cleanDate ? ` 📅 ${cleanDate}` : '';
  const tagText = Array.isArray(tags)
    ? [...new Set(tags.map((tag) => String(tag).trim().replace(/^#/, '')).filter(Boolean))].map((tag) => `#${tag}`).join(' ')
    : '';
  const task = `- [ ] ${title}${tagText ? ` ${tagText}` : ''}${dueMarker}${priorityMarker}`;
  let content = '';
  try { content = await fs.readFile(full, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+Tasks\s*$/i.test(line));
  if (heading >= 0) {
    let end = lines.length;
    for (let index = heading + 1; index < lines.length; index += 1) {
      if (/^#{1,2}\s+/.test(lines[index])) { end = index; break; }
    }
    if (lines.slice(heading + 1, end).some((line) => line.trim() === task)) {
      return { created: false, relativePath: relative };
    }
    while (end > heading + 1 && !lines[end - 1].trim()) end -= 1;
    lines.splice(end, 0, ...(end > heading + 1 ? [''] : []), task);
  } else {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push('## Tasks', '', task);
  }
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${lines.join('\n').trimEnd()}\n`, 'utf8');
  return { created: true, relativePath: relative };
}

function formatHabitFrontmatter(name, frequency, color) {
  return `---\ntype: habit\nhabit: true\nfrequency: ${frequency || 'daily'}\ncolor: ${color}\ncompleted: []\n---\n\n# ${name}\n\nA small practice, repeated with care.\n`;
}

async function handleListHabits() {
  const config = await readConfig();
  ensureConfigured(config);
  const root = path.join(config.vaultPath, safeRelative(config.habitsFolder, ''));
  const files = await walkMarkdown(root);
  const habits = [];
  for (const file of files) {
    const habit = parseHabit(file, await fs.readFile(file, 'utf8'), config.vaultPath);
    if (habit) habits.push(habit);
  }
  return habits.sort((a, b) => a.name.localeCompare(b.name));
}

function habitCommitmentFile(config) {
  return path.join(daybookDataFolder(config.vaultPath), 'habit-commitments.json');
}

async function handleListHabitCommitments() {
  const config = await readConfig();
  ensureConfigured(config);
  try {
    const commitments = JSON.parse(await fs.readFile(habitCommitmentFile(config), 'utf8'));
    return Array.isArray(commitments)
      ? commitments.filter((item) => item && typeof item.id === 'string' && ['month', 'quarter'].includes(item.period) && /^\d{4}-\d{2}-\d{2}$/.test(item.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(item.endDate) && Array.isArray(item.habits))
      : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Could not read saved habit commitments in this vault.');
  }
}

async function handleSaveHabitCommitment(input) {
  const config = await readConfig();
  ensureConfigured(config);
  const period = input?.period === 'quarter' ? 'quarter' : input?.period === 'month' ? 'month' : '';
  const startDate = String(input?.startDate || '');
  const endDate = String(input?.endDate || '');
  ensureDate(startDate);
  ensureDate(endDate);
  if (!period || startDate > endDate) throw new Error('Choose a valid month or quarter.');
  const requestedPaths = Array.isArray(input?.habits) ? [...new Set(input.habits.map((item) => String(item?.relativePath || '')))].filter(Boolean) : [];
  if (!requestedPaths.length) throw new Error('Select at least one habit for this commitment.');
  const selectedHabits = [];
  for (const relativePath of requestedPaths) {
    const full = path.resolve(config.vaultPath, relativePath.split('/').join(path.sep));
    const relative = path.relative(config.vaultPath, full);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('A selected habit is outside the vault.');
    const habit = parseHabit(full, await fs.readFile(full, 'utf8'), config.vaultPath);
    if (!habit) throw new Error('One of the selected notes is no longer marked as a habit. Refresh and try again.');
    selectedHabits.push({ relativePath: habit.relativePath, name: habit.name, frequency: habit.frequency, color: habit.color });
  }
  const file = habitCommitmentFile(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const commitments = await handleListHabitCommitments();
  const overlapping = commitments.find((item) => startDate <= item.endDate && endDate >= item.startDate);
  if (overlapping) throw new Error(`This period overlaps “${overlapping.name}”. Choose a period after it ends.`);
  const commitment = {
    id: `${Date.now()}-${period}`,
    name: String(input?.name || '').trim().slice(0, 100) || `${period === 'quarter' ? 'Quarter' : 'Month'} ${startDate.slice(0, 7)}`,
    period,
    startDate,
    endDate,
    createdAt: new Date().toISOString(),
    habits: selectedHabits
  };
  commitments.push(commitment);
  await fs.writeFile(file, JSON.stringify(commitments, null, 2), 'utf8');
  return commitments;
}

async function handleListProtocol(date) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const root = await resolveWellnessRoot(config);
  const files = await walkMarkdown(root);
  const month = date.slice(0, 7);
  const items = [];
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    const item = parseProtocolItem(file, content, config.vaultPath);
    if (item) items.push({ ...item, inProtocol: item.protocolMonths.includes(month) });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

async function handleListCommittedProtocol(date) {
  const { full } = await dayPath(date);
  let content = '';
  try { content = await fs.readFile(full, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const block = content.match(/<!-- daybook:protocol:start -->[\s\S]*?<!-- daybook:protocol:end -->/)?.[0] || '';
  const relativePaths = [];
  const itemTimings = {};
  const itemFrequencies = {};
  let timing = '';
  for (const line of block.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(Waking|Breakfast|Afternoon|Bedtime)\s*$/i);
    if (heading) timing = heading[1].toLowerCase();
    if (/^###\s+/.test(line) && !heading) timing = '';
    const link = line.match(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/);
    if (!link) continue;
    const relative = path.posix.normalize(link[1].trim().replaceAll('\\', '/').replace(/\.md$/i, '') + '.md');
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
    relativePaths.push(relative);
    itemTimings[relative] = timing;
    const details = line.split(/\s+—\s+/)[1] || '';
    const frequency = normalizeProtocolFrequency(details.split('·').at(-1)?.trim());
    if (frequency) itemFrequencies[relative] = frequency;
  }
  const names = [...block.matchAll(/^\*\*(.+?)\*\*\s*·/gm)].map((match) => match[1]);
  const times = [...block.matchAll(/^\*\*.+?\*\*\s*·\s*\d{4}-\d{2}-\d{2}\s*·\s*(\d{2}:\d{2})\s*$/gm)].map((match) => match[1]);
  return {
    committed: Boolean(block),
    name: names.join(' · '),
    time: times[0] || '',
    relativePaths: [...new Set(relativePaths)],
    itemTimings,
    itemFrequencies
  };
}

function protocolBundleFile(config) {
  return path.join(daybookDataFolder(config.vaultPath), 'protocol-bundles.json');
}

async function handleListProtocolBundles() {
  const config = await readConfig();
  ensureConfigured(config);
  try {
    const bundles = JSON.parse(await fs.readFile(protocolBundleFile(config), 'utf8'));
    return Array.isArray(bundles) ? bundles.filter((bundle) => bundle && typeof bundle.id === 'string' && typeof bundle.name === 'string' && Array.isArray(bundle.items)) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Could not read saved protocol bundles in this vault.');
  }
}

function protocolCycleFile(config) {
  return path.join(daybookDataFolder(config.vaultPath), 'protocol-cycles.json');
}

async function handleListProtocolCycles() {
  const config = await readConfig();
  ensureConfigured(config);
  try {
    const cycles = JSON.parse(await fs.readFile(protocolCycleFile(config), 'utf8'));
    return Array.isArray(cycles) ? cycles.filter((cycle) => cycle && typeof cycle.id === 'string' && typeof cycle.name === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(cycle.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(cycle.endDate) && Array.isArray(cycle.bundles)) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Could not read protocol cycles in this vault.');
  }
}

async function handleSaveProtocolCycle(cycleInput) {
  const config = await readConfig();
  ensureConfigured(config);
  const name = String(cycleInput?.name || '').trim().replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
  const startDate = String(cycleInput?.startDate || '');
  const endDate = String(cycleInput?.endDate || '');
  ensureDate(startDate);
  ensureDate(endDate);
  if (!name) throw new Error('Give this cycle a name.');
  if (startDate > endDate) throw new Error('The end date must be on or after the start date.');
  const file = protocolCycleFile(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const cycles = await handleListProtocolCycles();
  const id = String(cycleInput?.id || `${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
  const index = cycles.findIndex((cycle) => cycle.id === id);
  const cycle = { id, name, startDate, endDate, bundles: index >= 0 ? cycles[index].bundles : [] };
  if (index >= 0) cycles[index] = cycle;
  else cycles.push(cycle);
  await fs.writeFile(file, JSON.stringify(cycles, null, 2), 'utf8');
  return cycles;
}

async function handleSaveProtocolCycleBundle(cycleId, name, selections, bundleId = '', time = '08:00') {
  const config = await readConfig();
  ensureConfigured(config);
  const cleanName = String(name || '').trim().replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
  const cleanTime = String(time || '').trim();
  if (!cleanName) throw new Error('Give this bundle a name.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cleanTime)) throw new Error('Choose a valid time for this bundle.');
  if (!Array.isArray(selections) || selections.length === 0) throw new Error('Select at least one item for this bundle.');
  const cycles = await handleListProtocolCycles();
  const cycle = cycles.find((entry) => entry.id === cycleId);
  if (!cycle) throw new Error('Choose a protocol cycle first.');
  const items = [];
  const seen = new Set();
  for (const selection of selections) {
    const itemPath = String(selection?.relativePath || '');
    const full = path.resolve(config.vaultPath, itemPath.split('/').join(path.sep));
    const relative = path.relative(config.vaultPath, full);
    if (!itemPath || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('A selected item is outside the vault.');
    if (seen.has(itemPath)) continue;
    seen.add(itemPath);
    const parsed = parseProtocolItem(full, await fs.readFile(full, 'utf8'), config.vaultPath);
    if (!parsed) throw new Error(`“${path.basename(itemPath)}” is no longer recognized as a Wellness item.`);
    const timing = ['waking', 'breakfast', 'afternoon', 'bedtime'].includes(selection.timing) ? selection.timing : parsed.timing;
    const frequency = normalizeProtocolFrequency(selection.frequency);
    if (!frequency) throw new Error(`Choose a frequency and at least one weekday for “${parsed.name}”.`);
    items.push({ relativePath: parsed.relativePath, name: parsed.name, category: parsed.category, timing, frequency, dose: parsed.dose, route: parsed.route });
  }
  if (!items.length) throw new Error('Select at least one item for this bundle.');
  const index = cycle.bundles.findIndex((entry) => entry.id === bundleId || entry.name.toLowerCase() === cleanName.toLowerCase());
  const bundle = { id: index >= 0 ? cycle.bundles[index].id : `${Date.now()}-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: cleanName, time: cleanTime, items, completedDates: index >= 0 && Array.isArray(cycle.bundles[index].completedDates) ? cycle.bundles[index].completedDates : [] };
  if (index >= 0) cycle.bundles[index] = bundle;
  else cycle.bundles.push(bundle);
  const file = protocolCycleFile(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cycles, null, 2), 'utf8');
  return cycles;
}

async function handleSetProtocolCycleBundleCompletion(date, cycleId, bundleId, completed) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const cycles = await handleListProtocolCycles();
  const cycle = cycles.find((entry) => entry.id === cycleId);
  const bundle = cycle?.bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error('Choose a saved protocol bundle first.');
  if (date < cycle.startDate || date > cycle.endDate) throw new Error(`This cycle runs ${cycle.startDate} through ${cycle.endDate}. Choose a day within that range.`);
  const completedDates = new Set(Array.isArray(bundle.completedDates) ? bundle.completedDates : []);
  if (completed) completedDates.add(date);
  else completedDates.delete(date);
  bundle.completedDates = [...completedDates].sort();
  const file = protocolCycleFile(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cycles, null, 2), 'utf8');
  return cycles;
}

async function handleCommitCycleBundle(date, cycleId, bundleId) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const cycles = await handleListProtocolCycles();
  const cycle = cycles.find((entry) => entry.id === cycleId);
  if (!cycle) throw new Error('Choose a protocol cycle first.');
  if (date < cycle.startDate || date > cycle.endDate) throw new Error(`This cycle runs ${cycle.startDate} through ${cycle.endDate}. Choose a day within that range.`);
  const bundle = cycle.bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error('Choose a saved bundle first.');
  const items = [];
  for (const item of bundle.items.filter((entry) => protocolFrequencyMatchesDate(entry.frequency, date, cycle.startDate))) {
    const full = path.resolve(config.vaultPath, item.relativePath.split('/').join(path.sep));
    const content = await fs.readFile(full, 'utf8');
    const parsed = parseProtocolItem(full, content, config.vaultPath);
    if (parsed) items.push({ ...item, completed: Array.isArray(bundle.completedDates) && bundle.completedDates.includes(date) });
  }
  if (!items.length) throw new Error(`No items in “${bundle.name}” are scheduled for ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}.`);
  return writeProtocolSnapshot(date, { ...bundle, time: bundle.time || '08:00', items, name: `${cycle.name} · ${bundle.name}` });
}

async function handleSaveProtocolBundle(name, relativePaths) {
  const config = await readConfig();
  ensureConfigured(config);
  const cleanName = String(name || '').trim().replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
  if (!cleanName) throw new Error('Give this bundle a name.');
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) throw new Error('Select at least one Wellness item for this bundle.');
  const items = [];
  for (const itemPath of [...new Set(relativePaths)]) {
    const full = path.resolve(config.vaultPath, String(itemPath).split('/').join(path.sep));
    const relative = path.relative(config.vaultPath, full);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('A selected item is outside the vault.');
    const parsed = parseProtocolItem(full, await fs.readFile(full, 'utf8'), config.vaultPath);
    if (!parsed) throw new Error('A selected note is no longer recognized as a Wellness item.');
    items.push({ relativePath: parsed.relativePath, name: parsed.name, category: parsed.category, timing: parsed.timing, frequency: parsed.frequency, dose: parsed.dose, route: parsed.route });
  }
  const file = protocolBundleFile(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let bundles = await handleListProtocolBundles();
  const existingIndex = bundles.findIndex((bundle) => bundle.name.toLowerCase() === cleanName.toLowerCase());
  const bundle = { id: existingIndex >= 0 ? bundles[existingIndex].id : `${Date.now()}-${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: cleanName, items };
  if (existingIndex >= 0) bundles[existingIndex] = bundle;
  else bundles = [...bundles, bundle];
  await fs.writeFile(file, JSON.stringify(bundles, null, 2), 'utf8');
  return bundles;
}

async function handleCommitProtocolBundle(date, bundleId) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const bundles = await handleListProtocolBundles();
  const bundle = bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error('Choose a saved bundle first.');
  const items = bundle.items.filter((item) => protocolFrequencyMatchesDate(item.frequency, date));
  if (!items.length) throw new Error(`No items in “${bundle.name}” are scheduled for ${new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' })}.`);
  return writeProtocolSnapshot(date, { ...bundle, items });
}

async function writeProtocolSnapshot(date, bundle) {
  const groups = ['waking', 'breakfast', 'afternoon', 'bedtime'];
  const labels = { waking: 'Waking', breakfast: 'Breakfast', afternoon: 'Afternoon', bedtime: 'Bedtime' };
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(bundle.time || '')) ? bundle.time : '';
  const id = encodeURIComponent(String(bundle.id || bundle.name));
  const startMarker = `<!-- daybook:protocol-bundle:${id}:start -->`;
  const endMarker = `<!-- daybook:protocol-bundle:${id}:end -->`;
  const lines = [startMarker, `**${bundle.name}** · ${date}${time ? ` · ${time}` : ''}`, ''];
  for (const group of groups) {
    const items = bundle.items.filter((item) => item.timing === group);
    if (!items.length) continue;
    lines.push(`### ${labels[group]}`);
    for (const item of items) {
      const details = [item.category, item.dose, item.route, protocolFrequencyLabel(item.frequency)].filter(Boolean).join(' · ');
      lines.push(`- [${item.completed ? 'x' : ' '}] [[${item.relativePath.replace(/\.md$/i, '')}|${item.name}]]${details ? ` — ${details}` : ''}`);
    }
    lines.push('');
  }
  const unassigned = bundle.items.filter((item) => !groups.includes(item.timing));
  if (unassigned.length) {
    lines.push('### Unassigned');
    for (const item of unassigned) lines.push(`- [${item.completed ? 'x' : ' '}] [[${item.relativePath.replace(/\.md$/i, '')}|${item.name}]]${item.category ? ` — ${item.category}` : ''}`);
    lines.push('');
  }
  lines.push(endMarker);
  const { full, relative } = await dayPath(date);
  await fs.mkdir(path.dirname(full), { recursive: true });
  let content = '';
  try { content = await fs.readFile(full, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bundleBlock = lines.join('\n');
  const marker = /<!-- daybook:protocol:start -->[\s\S]*?<!-- daybook:protocol:end -->/;
  let updated;
  if (marker.test(content)) {
    const protocolBlock = content.match(marker)[0];
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bundleMarker = new RegExp(`<!-- daybook:protocol-bundle:${escapedId}:start -->[\\s\\S]*?<!-- daybook:protocol-bundle:${escapedId}:end -->`);
    const replaced = bundleMarker.test(protocolBlock)
      ? protocolBlock.replace(bundleMarker, bundleBlock)
      : protocolBlock.replace('<!-- daybook:protocol:end -->', `${bundleBlock}\n\n<!-- daybook:protocol:end -->`);
    updated = content.replace(marker, replaced);
  } else {
    const legacy = content.match(/<!-- daybook:protocol:start -->[\s\S]*?<!-- daybook:protocol:end -->/)?.[0];
    const section = legacy
      ? legacy.replace('<!-- daybook:protocol:end -->', `${bundleBlock}\n\n<!-- daybook:protocol:end -->`)
      : `<!-- daybook:protocol:start -->\n## Daily protocol\n\n${bundleBlock}\n\n<!-- daybook:protocol:end -->`;
    updated = legacy ? content.replace(legacy, section) : `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${section}\n`;
  }
  await fs.writeFile(full, updated, 'utf8');
  return { relativePath: relative, name: bundle.name, count: bundle.items.length, time };
}

async function handleSetProtocolMembership(relativePath, date, selected) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const normalized = String(relativePath || '').split('/').join(path.sep);
  const full = path.resolve(config.vaultPath, normalized);
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('That item is outside the selected vault.');
  const content = await fs.readFile(full, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || !parseProtocolItem(full, content, config.vaultPath)) throw new Error('This note is no longer recognized as a Wellness item.');
  const month = date.slice(0, 7);
  const meta = frontmatter[1];
  const months = yamlList(meta, 'protocol');
  if (!selected && !months.includes(month)) return { relativePath, protocolMonths: months, inProtocol: false };
  const next = selected ? [...new Set([...months, month])].sort() : months.filter((value) => value !== month);
  const property = /^protocol:[^\r\n]*(?:\r?\n(?:[ \t]+-.*(?:\r?\n|$))*)?/im;
  const nextProperty = next.length ? `protocol:\n${next.map((value) => `  - ${value}`).join('\n')}\n` : 'protocol: []\n';
  const nextMeta = property.test(meta)
    ? meta.replace(property, nextProperty)
    : `${meta.trimEnd()}\n${nextProperty}`;
  await fs.writeFile(full, content.replace(frontmatter[1], nextMeta), 'utf8');
  return { relativePath, protocolMonths: next, inProtocol: next.includes(month) };
}

async function handleSetProtocolFrequency(relativePath, frequency) {
  const normalizedFrequency = normalizeProtocolFrequency(frequency);
  if (!normalizedFrequency || normalizedFrequency === 'days:') throw new Error('Choose a frequency and at least one weekday.');
  const config = await readConfig();
  ensureConfigured(config);
  const normalized = String(relativePath || '').split('/').join(path.sep);
  const full = path.resolve(config.vaultPath, normalized);
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('That item is outside the selected vault.');
  const content = await fs.readFile(full, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || !parseProtocolItem(full, content, config.vaultPath)) throw new Error('This note is no longer recognized as a Wellness item.');
  const meta = frontmatter[1];
  const property = /^frequency:[^\r\n]*(?:\r?\n(?:[ \t]+-.*(?:\r?\n|$))*)?/im;
  const selectedDays = normalizedFrequency.startsWith('days:') ? normalizedFrequency.slice(5).split(',') : [];
  const nextProperty = normalizedFrequency.startsWith('days:')
    ? `frequency:\n${PROTOCOL_WEEKDAYS.filter((day) => selectedDays.includes(day.key)).map((day) => `  - ${day.label}`).join('\n')}\n`
    : `frequency:\n  - ${protocolFrequencyLabel(normalizedFrequency)}\n`;
  const nextMeta = property.test(meta)
    ? meta.replace(property, nextProperty)
    : `${meta.trimEnd()}\n${nextProperty}`;
  await fs.writeFile(full, content.replace(frontmatter[1], nextMeta), 'utf8');
  return { relativePath, frequency: normalizedFrequency };
}

async function handleToggleHabit(relativePath, date) {
  ensureDate(date);
  const config = await readConfig();
  ensureConfigured(config);
  const normalized = relativePath.split('/').join(path.sep);
  const full = path.resolve(config.vaultPath, normalized);
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('That habit is outside the selected vault.');
  const content = await fs.readFile(full, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || (!isHabitFrontmatter(frontmatter[1]) && !parseProtocolItem(full, content, config.vaultPath))) throw new Error('This note is no longer marked as a habit or protocol item.');
  const meta = frontmatter[1];
  const current = isHabitFrontmatter(meta)
    ? parseHabit(full, content, config.vaultPath).completed
    : parseProtocolItem(full, content, config.vaultPath).completed;
  const next = current.includes(date) ? current.filter((item) => item !== date) : [...current, date].sort();
  let nextMeta;
  if (/^completed:.*$/m.test(meta)) {
    nextMeta = meta.replace(/^completed:[ \t]*(?:\r?\n(?:[ \t]+-\s*.*(?:\r?\n|$))*)?/m, `completed:\n${next.map((item) => `  - ${item}`).join('\n')}${next.length ? '\n' : ''}`);
  } else {
    nextMeta = `${meta.trimEnd()}\ncompleted:\n${next.map((item) => `  - ${item}`).join('\n')}${next.length ? '\n' : ''}`;
  }
  await fs.writeFile(full, content.replace(frontmatter[1], nextMeta), 'utf8');
  return { completed: next, done: next.includes(date) };
}

async function handleCreateProtocolItem(name, category, timing, frequency, description = '', date) {
  const config = await readConfig();
  ensureConfigured(config);
  ensureDate(date);
  const clean = name.trim().replace(/[\r\n]+/g, ' ').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  if (!clean) throw new Error('Give this protocol item a name.');
  if (!PROTOCOL_CATEGORIES.includes(category)) throw new Error('Choose a protocol category.');
  if (!PROTOCOL_TIMES.includes(timing)) throw new Error('Choose one of the four daily areas.');
  const normalizedFrequency = normalizeProtocolFrequency(frequency);
  if (!normalizedFrequency || normalizedFrequency === 'days:') throw new Error('Choose a frequency and at least one weekday.');
  const root = await resolveWellnessRoot(config);
  const categoryFolder = ({ peptide: 'PEPTIDES', supplement: 'SUPPLEMENTS', bioregulator: 'BIOREGULATORS', prescription: 'PRESCRIPTIONS' })[category];
  const folder = path.join(root, categoryFolder);
  await fs.mkdir(folder, { recursive: true });
  let full = path.join(folder, `${clean}.md`);
  let suffix = 2;
  while (true) {
    try { await fs.access(full); full = path.join(folder, `${clean} ${suffix++}.md`); }
    catch { break; }
  }
  const detail = String(description || '').trim().replace(/[\r\n]+/g, ' ');
  const selectedDays = normalizedFrequency.startsWith('days:') ? normalizedFrequency.slice(5).split(',') : [];
  const frequencyYaml = normalizedFrequency.startsWith('days:')
    ? PROTOCOL_WEEKDAYS.filter((day) => selectedDays.includes(day.key)).map((day) => `  - ${day.label}`).join('\n')
    : `  - ${protocolFrequencyLabel(normalizedFrequency)}`;
  const content = `---\ntags:\n  - wellness-item\ntype: ${category}\ncategory: ${category}\ntiming: ${timing}\nfrequency:\n${frequencyYaml}\nprotocol:\n  - ${date.slice(0, 7)}\ncompleted: []\n---\n\n# ${clean}\n${detail ? `\n${detail}\n` : ''}`;
  await fs.writeFile(full, content, 'utf8');
  return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), name: clean };
}

async function handleCreateHabit(name, frequency, color = '#35ce2b') {
  const config = await readConfig();
  ensureConfigured(config);
  const clean = name.trim().replace(/[\r\n]+/g, ' ').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ');
  if (!clean) throw new Error('Give your habit a name.');
  const folder = path.join(config.vaultPath, safeRelative(config.habitsFolder, ''));
  await fs.mkdir(folder, { recursive: true });
  let full = path.join(folder, `${clean}.md`);
  let suffix = 2;
  while (true) {
    try { await fs.access(full); full = path.join(folder, `${clean} ${suffix++}.md`); }
    catch { break; }
  }
  const normalizedColor = /^#[0-9a-f]{6}$/i.test(String(color)) ? String(color).toLowerCase() : '#35ce2b';
  await fs.writeFile(full, formatHabitFrontmatter(clean, frequency, normalizedColor), 'utf8');
  return { relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'), name: clean };
}

async function handleSetHabitColor(relativePath, color) {
  const config = await readConfig();
  ensureConfigured(config);
  if (!/^#[0-9a-f]{6}$/i.test(String(color))) throw new Error('Choose a valid habit color.');
  const full = path.resolve(config.vaultPath, String(relativePath || '').split('/').join(path.sep));
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('That habit is outside the selected vault.');
  const content = await fs.readFile(full, 'utf8');
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter || !isHabitFrontmatter(frontmatter[1])) throw new Error('This note is no longer marked as a habit.');
  const meta = frontmatter[1];
  const nextMeta = /^color:[^\r\n]*$/m.test(meta)
    ? meta.replace(/^color:[^\r\n]*$/m, `color: ${String(color).toLowerCase()}`)
    : `${meta.trimEnd()}\ncolor: ${String(color).toLowerCase()}`;
  await fs.writeFile(full, content.replace(frontmatter[1], nextMeta), 'utf8');
  return { color: String(color).toLowerCase() };
}

async function handleListObsidianTasks() {
  const config = await readConfig();
  ensureConfigured(config);
  const files = await walkMarkdown(config.vaultPath);
  const tasks = [];
  for (const full of files) {
    const content = await fs.readFile(full, 'utf8');
    let insideDaybook = false;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.includes(START)) { insideDaybook = true; continue; }
      if (line.includes(END)) { insideDaybook = false; continue; }
      if (insideDaybook) continue;
      const match = line.match(/^\s*- \[ \]\s+(.+?)\s*$/);
      if (match) {
        const dueMatch = match[1].match(/(?:📅\s*|\bdue(?:\s+date)?\s*::?\s*)(\d{4}-\d{2}-\d{2})/i);
        const priorityMatch = match[1].match(/(🔺|⏫|🔼|➖|🔽)|\bpriority\s*::?\s*(urgent|high|medium|normal|low)\b/i);
        const priorityToken = priorityMatch?.[1] || priorityMatch?.[2]?.toLowerCase() || '';
        const priority = ({ '🔺': 4, '⏫': 3, '🔼': 2, '➖': 1, '🔽': 1, urgent: 4, high: 3, medium: 2, normal: 1, low: 1 })[priorityToken] || 1;
        const displayText = match[1]
          .replace(/(?:📅\s*|\bdue(?:\s+date)?\s*::?\s*)\d{4}-\d{2}-\d{2}/ig, '')
          .replace(/(?:🔺|⏫|🔼|➖|🔽|\bpriority\s*::?\s*(?:urgent|high|medium|normal|low)\b)/ig, '')
          .replace(/\s{2,}/g, ' ').trim();
        const personLinks = [...new Set((match[1].match(/\[\[[^\]]+\]\]/g) || []))];
        tasks.push({
        text: match[1],
        displayText,
        dueDate: dueMatch?.[1] || '',
        priority,
        relativePath: path.relative(config.vaultPath, full).split(path.sep).join('/'),
        fileName: path.basename(full, path.extname(full)),
        line: index + 1,
        people: personLinks
        });
      }
    }
  }
  return tasks;
}

async function handleUpdateObsidianTaskProperties(relativePath, lineNumber, expectedText, dueDate, priority) {
  const config = await readConfig();
  ensureConfigured(config);
  const full = path.resolve(config.vaultPath, String(relativePath || '').split('/').join(path.sep));
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !full.toLowerCase().endsWith('.md')) throw new Error('That task is outside the selected vault.');
  const cleanDate = String(dueDate || '');
  if (cleanDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) throw new Error('Choose a valid due date.');
  const level = Math.min(4, Math.max(1, Number(priority) || 1));
  const content = await fs.readFile(full, 'utf8');
  const lines = content.split(/\r?\n/);
  const expected = String(expectedText || '').trim();
  const hintedIndex = Number(lineNumber) - 1;
  const candidates = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*- \[ \]\s+(.+?)\s*$/);
    if (match?.[1] === expected) candidates.push(index);
  }
  const targetIndex = candidates.sort((a, b) => Math.abs(a - hintedIndex) - Math.abs(b - hintedIndex))[0];
  if (targetIndex === undefined) throw new Error('This note changed. Refresh the Obsidian task list and try again.');
  const lineMatch = lines[targetIndex].match(/^(\s*- \[ \]\s+)(.+?)\s*$/);
  let text = lineMatch[2]
    .replace(/(?:📅\s*|\bdue(?:\s+date)?\s*::?\s*)\d{4}-\d{2}-\d{2}/ig, '')
    .replace(/(?:🔺|⏫|🔼|➖|🔽|\bpriority\s*::?\s*(?:urgent|high|medium|normal|low)\b)/ig, '')
    .replace(/\s{2,}/g, ' ').trim();
  if (cleanDate) text += ` 📅 ${cleanDate}`;
  text += ` ${{ 1: '➖', 2: '🔼', 3: '⏫', 4: '🔺' }[level]}`;
  lines[targetIndex] = `${lineMatch[1]}${text}`;
  await fs.writeFile(full, lines.join('\n'), 'utf8');
  return { saved: true };
}

async function handleToggleObsidianTask(relativePath, lineNumber, expectedText) {
  const config = await readConfig();
  ensureConfigured(config);
  const full = path.resolve(config.vaultPath, relativePath.split('/').join(path.sep));
  const relative = path.relative(config.vaultPath, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !full.toLowerCase().endsWith('.md')) {
    throw new Error('That task is outside the selected vault.');
  }
  const content = await fs.readFile(full, 'utf8');
  const lines = content.split(/\r?\n/);
  const targetText = String(expectedText || '').trim();
  const hintedIndex = Number(lineNumber) - 1;
  const openMatches = [];
  const completedMatches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*- \[([ xX])\]\s+(.+?)\s*$/);
    if (!match || match[2] !== targetText) continue;
    const candidate = { index, line: lines[index], open: match[1] === ' ' };
    (candidate.open ? openMatches : completedMatches).push(candidate);
  }
  const candidates = openMatches.length ? openMatches : completedMatches;
  const target = candidates.sort((a, b) => Math.abs(a.index - hintedIndex) - Math.abs(b.index - hintedIndex))[0];
  if (!target) {
    throw new Error('This note changed. Refresh the Obsidian task list and try again.');
  }
  if (!target.open) return { done: true, alreadyDone: true };
  lines[target.index] = target.line.replace(/\[ \]/, '[x]');
  await fs.writeFile(full, lines.join('\n'), 'utf8');
  return { done: true };
}

async function todoistRequest(endpoint, options = {}) {
  const config = await readConfig();
  if (!config.todoistToken) throw new Error('Add your Todoist API token in Settings to connect tasks.');
  const response = await fetch(`https://api.todoist.com/api/v1${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.todoistToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.message || data.detail || `Todoist returned ${response.status}.`);
  return data;
}

async function todoistSync(resourceTypes) {
  const config = await readConfig();
  if (!config.todoistToken) throw new Error('Add your Todoist API token in Settings to connect filters.');
  const body = new URLSearchParams({ sync_token: '*', resource_types: JSON.stringify(resourceTypes) });
  const response = await fetch('https://api.todoist.com/api/v1/sync', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.todoistToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data.message || data.detail || `Todoist returned ${response.status}.`);
  return data;
}

async function handleGetTodoistFilters() {
  const data = await todoistSync(['filters', 'workspace_filters']);
  return [...(data.filters || []), ...(data.workspace_filters || [])]
    .filter((filter) => !filter.is_deleted)
    .map(({ id, name, query }) => ({ id, name, query }));
}

async function filteredTasks(filterQuery) {
  const tasks = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ query: filterQuery, limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await todoistRequest(`/tasks/filter?${params.toString()}`);
    tasks.push(...(data.results || data.tasks || []));
    cursor = data.next_cursor || '';
  } while (cursor);
  return tasks;
}

async function listTodoistProjects() {
  const projects = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await todoistRequest(`/projects?${params.toString()}`);
    projects.push(...(data.results || data.projects || []));
    cursor = data.next_cursor || '';
  } while (cursor);
  return projects;
}

async function listTodoistTasks() {
  const tasks = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await todoistRequest(`/tasks?${params.toString()}`);
    tasks.push(...(data.results || data.tasks || []));
    cursor = data.next_cursor || '';
  } while (cursor);
  return tasks.filter((task) => !task.checked && !task.is_deleted && !task.isDeleted);
}

function todoistPriorityNumber(priority) {
  const value = String(priority ?? '').toLowerCase();
  if (value === 'p1') return 4;
  if (value === 'p2') return 3;
  if (value === 'p3') return 2;
  if (value === 'p4') return 1;
  return Math.min(4, Math.max(1, Number(priority) || 1));
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function listTodoistSections(projectId) {
  if (!projectId) return [];
  const sections = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ project_id: String(projectId), limit: '200' });
    if (cursor) params.set('cursor', cursor);
    const data = await todoistRequest(`/sections?${params.toString()}`);
    sections.push(...(data.results || data.sections || []));
    cursor = data.next_cursor || '';
  } while (cursor);
  return sections;
}

async function handleListTodoistProjects() {
  const projects = await listTodoistProjects();
  return projects.filter((project) => !project.is_deleted).map(({ id, name, is_inbox_project, parent_id }) => ({ id, name, is_inbox_project, parent_id }));
}

async function handleListTodoistSections(projectId) {
  return (await listTodoistSections(projectId)).filter((section) => !section.is_deleted).map(({ id, name, project_id }) => ({ id, name, project_id }));
}

async function handleGetTasks() {
  const config = await readConfig();
  if (!config.todoistToken) return { connected: false, configured: false, tasksByQuadrant: {}, dueToday: [] };
  const [tasks, projects] = await Promise.all([listTodoistTasks(), listTodoistProjects()]);
  const projectNames = new Map(projects.map((project) => [String(project.id), project.name]));
  const today = localDateKey(new Date());
  const sevenDays = new Date();
  sevenDays.setHours(12, 0, 0, 0);
  sevenDays.setDate(sevenDays.getDate() + 7);
  const urgentThrough = localDateKey(sevenDays);
  const normalizedTasks = tasks.map((task) => {
    const priority = todoistPriorityNumber(task.priority);
    const dueDate = String(task.due?.date || task.due?.datetime || task.due_date || '').slice(0, 10);
    const urgent = Boolean(dueDate && dueDate <= urgentThrough);
    const important = priority >= 3;
    const quadrant = important ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'later');
    return {
      ...task,
      priority,
      due: task.due || (dueDate ? { date: dueDate, string: dueDate } : null),
      projectName: projectNames.get(String(task.project_id || task.projectId)) || 'No project',
      quadrant
    };
  });
  const tasksByQuadrant = { do: [], schedule: [], delegate: [], later: [] };
  for (const task of normalizedTasks) tasksByQuadrant[task.quadrant].push(task);
  for (const tasksInQuadrant of Object.values(tasksByQuadrant)) {
    tasksInQuadrant.sort((a, b) => String(a.due?.date || '9999-12-31').localeCompare(String(b.due?.date || '9999-12-31'))
      || b.priority - a.priority || String(a.content || '').localeCompare(String(b.content || ''), undefined, { sensitivity: 'base' }));
  }
  const dueToday = normalizedTasks.filter((task) => String(task.due?.date || '').slice(0, 10) === today);
  return { connected: true, configured: true, tasksByQuadrant, dueToday };
}

async function handleCreateTask(task) {
  task = task || {};
  const content = String(task?.content || '').trim();
  if (!content) throw new Error('Enter a task name.');
  const body = { content };
  for (const field of ['project_id', 'section_id', 'description']) {
    if (task[field]) body[field] = String(task[field]).trim();
  }
  if (task.priority) body.priority = Number(task.priority);
  if (task.labels) body.labels = String(task.labels).split(',').map((label) => label.trim()).filter(Boolean);
  if (task.dueDate && task.dueTime) {
    const localDateTime = new Date(`${task.dueDate}T${task.dueTime}`);
    if (Number.isNaN(localDateTime.getTime())) throw new Error('Choose a valid due date and time.');
    body.due_datetime = localDateTime.toISOString();
  } else if (task.dueDate) {
    body.due_date = task.dueDate;
  }
  return todoistRequest('/tasks', { method: 'POST', body: JSON.stringify(body) });
}

async function handleUpdateTodoistTask(id, task = {}) {
  const dueDate = String(task.dueDate || '');
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new Error('Choose a valid due date.');
  const priority = Math.min(4, Math.max(1, Number(task.priority) || 1));
  return todoistRequest(`/tasks/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ due_date: dueDate || null, priority })
  });
}

async function handleCompleteTask(id) {
  await todoistRequest(`/tasks/${encodeURIComponent(id)}/close`, { method: 'POST' });
  return { done: true };
}

async function handleListHevyWorkouts() {
  const config = await readConfig();
  const credentialHash = config.hevyApiKey ? crypto.createHash('sha256').update(config.hevyApiKey).digest('hex') : '';
  const cached = await readHevyWorkoutCache(credentialHash, config.vaultPath);
  if (!config.hevyApiKey) return { connected: false, workouts: cached?.workouts || [], cachedAt: cached?.cachedAt || '', fromCache: Boolean(cached), error: cached ? 'Showing saved workout history. Add your Hevy API key to sync new sessions.' : '' };
  const pageSize = 10;
  const pageLimit = 100;
  const rawWorkouts = [];
  let pageCount = null;
  try {
    for (let page = 1; page <= Math.min(pageCount || pageLimit, pageLimit); page += 1) {
      let response;
      try {
        response = await fetch(`https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=${pageSize}`, {
          headers: { 'api-key': config.hevyApiKey, Accept: 'application/json' }
        });
      } catch {
        throw new Error('Could not reach Hevy. Check your internet connection and try again.');
      }
      if (response.status === 401 || response.status === 403) throw new Error('Hevy did not accept this API key. Check it in Settings.');
      if (!response.ok) throw new Error(`Hevy returned an error (${response.status}). Try again later.`);
      const payload = await response.json();
      const workouts = Array.isArray(payload) ? payload : (payload.workouts || payload.data?.workouts || (Array.isArray(payload.data) ? payload.data : []));
      if (!Array.isArray(workouts) || workouts.length === 0) break;
      rawWorkouts.push(...workouts);
      const totalPages = Number(payload.page_count ?? payload.pageCount ?? payload.total_pages ?? payload.totalPages);
      if (Number.isFinite(totalPages) && totalPages > 0) pageCount = totalPages;
      if (pageCount && page >= pageCount) break;
      if (!pageCount && workouts.length < pageSize) break;
    }
    const uniqueWorkouts = [...new Map(rawWorkouts.map((workout, index) => [String(workout.id || workout.workout_id || `${workout.start_time || workout.startTime || ''}-${index}`), workout])).values()];
    const normalizedWorkouts = uniqueWorkouts.map((workout) => {
      const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
      const startedAt = workout.start_time || workout.startTime || workout.date || '';
      const endedAt = workout.end_time || workout.endTime || '';
      const durationSeconds = Number(workout.duration_seconds ?? workout.duration ?? 0)
        || (startedAt && endedAt ? (Date.parse(endedAt) - Date.parse(startedAt)) / 1000 : 0);
      return {
        id: workout.id || workout.workout_id || '',
        title: workout.title || workout.name || 'Workout',
        startTime: startedAt,
        durationMinutes: durationSeconds > 0 ? Math.round(durationSeconds / 60) : 0,
        exerciseCount: exercises.length,
        exercises: exercises.map((exercise) => ({
          name: exercise.title || exercise.name || exercise.exercise_template?.title || 'Exercise',
          sets: Array.isArray(exercise.sets) ? exercise.sets.map((set) => ({
            type: set.type || '',
            reps: Number(set.reps) || 0,
            weightKg: Number(set.weight_kg ?? set.weightKg ?? set.weight) || 0,
            distanceMeters: Number(set.distance_meters ?? set.distanceMeters) || 0,
            durationSeconds: Number(set.duration_seconds ?? set.durationSeconds) || 0
          })) : []
        }))
      };
    });
    const cachedAt = new Date().toISOString();
    try { await writeHevyWorkoutCache(normalizedWorkouts, cachedAt, config.vaultPath); } catch {}
    return { connected: true, workouts: normalizedWorkouts, cachedAt, fromCache: false, error: '' };
  } catch (error) {
    if (cached) return { connected: true, workouts: cached.workouts, cachedAt: cached.cachedAt || '', fromCache: true, error: error.message };
    throw error;
  }
}

async function handleGetCachedHevyWorkouts() {
  const config = await readConfig();
  const credentialHash = config.hevyApiKey ? crypto.createHash('sha256').update(config.hevyApiKey).digest('hex') : '';
  const cached = await readHevyWorkoutCache(credentialHash, config.vaultPath);
  return {
    connected: Boolean(config.hevyApiKey),
    workouts: cached?.workouts || [],
    cachedAt: cached?.cachedAt || '',
    fromCache: Boolean(cached),
    error: !config.hevyApiKey && cached ? 'Showing saved workout history. Add your Hevy API key to sync new sessions.' : ''
  };
}

async function handleListWrikeTasks() {
  const config = await readConfig();
  if (!config.wrikeToken) return { connected: false, tasks: [] };
  const request = async (endpoint) => {
    const response = await fetch(`${normalizeWrikeHost(config.wrikeHost)}/api/v4${endpoint}`, {
      headers: { Authorization: `Bearer ${config.wrikeToken}`, Accept: 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.errorDescription || body.error || `Wrike returned ${response.status}.`);
    return body.data || [];
  };
  const contacts = await request('/contacts?me=true');
  const self = contacts[0];
  if (!self?.id) throw new Error('Wrike could not identify the connected account.');
  let tasks = [];
  let pageToken = '';
  for (let page = 0; page < 10; page += 1) {
    const params = new URLSearchParams({ responsibles: self.id, status: 'Active', pageSize: '100' });
    if (pageToken) params.set('nextPageToken', pageToken);
    const response = await fetch(`${normalizeWrikeHost(config.wrikeHost)}/api/v4/tasks?${params}`, {
      headers: { Authorization: `Bearer ${config.wrikeToken}`, Accept: 'application/json' }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) throw new Error(body.errorDescription || body.error || `Wrike returned ${response.status}.`);
    tasks.push(...(body.data || []));
    pageToken = body.nextPageToken || '';
    if (!pageToken) break;
  }
  return { connected: true, tasks: tasks.map((task) => ({
    id: task.id, title: task.title || 'Untitled task', dueDate: task.dates?.due || '',
    priority: ({ High: 3, Normal: 2, Low: 1 })[task.importance] || 2,
    projectName: task.parentIds?.[0] || 'Wrike', detail: 'Wrike', permalink: task.permalink || ''
  })) };
}

async function handleListServiceNowTasks() {
  const config = await readConfig();
  const authType = config.serviceNowAuthType || 'basic';
  const credential = authType === 'basic' ? config.serviceNowPassword : config.serviceNowToken;
  if (!config.serviceNowInstance || !config.serviceNowUser || !credential) return { connected: false, tasks: [] };
  const instance = normalizeServiceNowInstance(config.serviceNowInstance);
  const authHeaders = authType === 'apiKey'
    ? { 'x-sn-apikey': config.serviceNowToken }
    : authType === 'bearer'
      ? { Authorization: `Bearer ${config.serviceNowToken}` }
      : { Authorization: `Basic ${Buffer.from(`${config.serviceNowUser}:${config.serviceNowPassword}`).toString('base64')}` };
  const getTable = async (table, query, fields) => {
    const params = new URLSearchParams({ sysparm_query: query, sysparm_limit: '100', sysparm_display_value: 'true', sysparm_fields: fields.join(',') });
    const response = await fetch(`${instance}/api/now/table/${table}?${params}`, { headers: { ...authHeaders, Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || body.error?.detail || `ServiceNow returned ${response.status}.`);
    return body.result || [];
  };
  const fields = ['sys_id', 'number', 'short_description', 'priority', 'due_date', 'sys_class_name', 'assigned_to', 'requested_for', 'state'];
  const [incidents, items, requests] = await Promise.all([
    getTable('incident', `active=true^assigned_to.user_name=${config.serviceNowUser}`, fields),
    getTable('sc_req_item', `active=true^requested_for.user_name=${config.serviceNowUser}`, fields),
    getTable('sc_request', `active=true^requested_for.user_name=${config.serviceNowUser}`, fields)
  ]);
  const normalize = (record, table, type) => ({
    id: record.sys_id, table, number: record.number, title: record.short_description || `${type} ${record.number || ''}`,
    dueDate: String(record.due_date || '').slice(0, 10), priority: ({ '1': 4, '2': 3, '3': 2, '4': 1, '5': 1 })[String(record.priority)] || 1,
    projectName: type, detail: `${type}${record.number ? ` · ${record.number}` : ''}`, state: record.state || ''
  });
  return { connected: true, tasks: [
    ...incidents.map((record) => normalize(record, 'incident', 'Incident')),
    ...requests.map((record) => normalize(record, 'sc_request', 'Request')),
    ...items.map((record) => normalize(record, 'sc_req_item', 'Request item'))
  ] };
}

async function handleOpenNote(relativePath) {
  const config = await readConfig();
  ensureConfigured(config);
  const vaultName = path.basename(config.vaultPath);
  await shell.openExternal(`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relativePath.replace(/\.md$/i, ''))}`);
}

async function handleOpenNativeTask(source, id) {
  const identifier = String(id || '');
  if (source === 'todoist') {
    if (!/^[A-Za-z0-9_-]+$/.test(identifier)) throw new Error('This Todoist task has an invalid ID. Refresh the task list and try again.');
    await shell.openExternal(`todoist://task?id=${encodeURIComponent(identifier)}`);
    return { opened: true };
  }
  if (source === 'reminder') {
    const uuid = identifier.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (!uuid) {
      await shell.openExternal('x-apple-reminderkit://');
      return { opened: true, reminderSelected: false };
    }
    await shell.openExternal(`x-apple-reminderkit://REMCDReminder/${uuid}`);
    return { opened: true, reminderSelected: true };
  }
  if (source === 'wrike') {
    const url = new URL(String(id || ''));
    if (url.protocol !== 'https:' || !/(^|\.)wrike\.com$/i.test(url.hostname)) throw new Error('This Wrike task link is invalid.');
    await shell.openExternal(url.toString());
    return { opened: true };
  }
  if (source === 'serviceNow') {
    const [table, sysId] = String(id || '').split(':');
    if (!['incident', 'sc_request', 'sc_req_item'].includes(table) || !/^[0-9a-f]{32}$/i.test(sysId || '')) throw new Error('This ServiceNow record link is invalid.');
    const config = await readConfig();
    if (!config.serviceNowInstance) throw new Error('Add your ServiceNow instance in Settings first.');
    await shell.openExternal(`${normalizeServiceNowInstance(config.serviceNowInstance)}/nav_to.do?uri=${table}.do%3Fsys_id%3D${sysId}`);
    return { opened: true };
  }
  throw new Error('This task source cannot be opened in a native app.');
}

function registerIpc() {
  ipcMain.handle('config:get', async () => publicConfig(await readConfig()));
  ipcMain.handle('config:save', async (_event, next) => publicConfig(await writeConfig(next)));
  ipcMain.handle('hevy:developer-settings', () => shell.openExternal('https://hevy.com/settings?developer'));
  ipcMain.handle('vault:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return writeConfig({ vaultPath: result.filePaths[0] });
  });
  ipcMain.handle('day:get', (_event, date) => handleGetDay(date));
  ipcMain.handle('day:image:upload', (_event, date) => chooseDayImage(date));
  ipcMain.handle('day:image:photos', (_event, date) => importSelectedPhoto(date));
  ipcMain.handle('calendar:list', (_event, date) => handleGetCalendarEvents(date));
  ipcMain.handle('calendar:list-month', (_event, month) => handleGetCalendarMonth(month));
  ipcMain.handle('calendar:meeting-note', (_event, calendarEvent) => handleCreateMeetingNote(calendarEvent));
  ipcMain.handle('calendar:create-meeting', (_event, meeting) => handleCreateCalendarMeeting(meeting));
  ipcMain.handle('meetings:list', handleListMeetingNotes);
  ipcMain.handle('people:list', handleListPeople);
  ipcMain.handle('people:create', (_event, person) => handleCreatePerson(person));
  ipcMain.handle('people:task-links:save', (_event, taskKey, people) => handleSetTaskPeople(taskKey, people));
  ipcMain.handle('meetings:star', (_event, relativePath, starred) => handleSetMeetingStarred(relativePath, starred));
  ipcMain.handle('meetings:get', (_event, relativePath) => handleGetMeetingNote(relativePath));
  ipcMain.handle('meetings:save', (_event, relativePath, agenda, notes, actionItems, expectedContent) => handleSaveMeetingNote(relativePath, agenda, notes, actionItems, expectedContent));
  ipcMain.handle('projects:list', handleListProjects);
  ipcMain.handle('projects:save', (_event, project) => handleSaveProject(project));
  ipcMain.handle('calendar:request', handleRequestCalendarAccess);
  ipcMain.handle('calendar:settings', openCalendarPrivacySettings);
  ipcMain.handle('reminders:list', handleListReminders);
  ipcMain.handle('reminders:create', (_event, title, dueDate, priority) => handleCreateReminder(title, dueDate, priority));
  ipcMain.handle('reminders:update', (_event, id, dueDate, priority) => handleUpdateReminder(id, dueDate, priority));
  ipcMain.handle('reminders:complete', (_event, id) => handleCompleteReminder(id));
  ipcMain.handle('day:save', (_event, date, day, expectedBlock) => handleSaveDay(date, day, expectedBlock));
  ipcMain.handle('obsidian-tasks:create-from-journal', (_event, date, text, tags, dueDate, priority) => handleCreateObsidianTaskFromJournal(date, text, tags, dueDate, priority));
  ipcMain.handle('habits:list', handleListHabits);
  ipcMain.handle('habits:commitments:list', handleListHabitCommitments);
  ipcMain.handle('habits:commitments:save', (_event, commitment) => handleSaveHabitCommitment(commitment));
  ipcMain.handle('protocol:list', (_event, date) => handleListProtocol(date));
  ipcMain.handle('protocol:committed:list', (_event, date) => handleListCommittedProtocol(date));
  ipcMain.handle('protocol:bundles:list', handleListProtocolBundles);
  ipcMain.handle('protocol:bundles:save', (_event, name, files) => handleSaveProtocolBundle(name, files));
  ipcMain.handle('protocol:bundles:commit', (_event, date, id) => handleCommitProtocolBundle(date, id));
  ipcMain.handle('protocol:cycles:list', handleListProtocolCycles);
  ipcMain.handle('protocol:cycles:save', (_event, cycle) => handleSaveProtocolCycle(cycle));
  ipcMain.handle('protocol:cycles:bundle:save', (_event, cycleId, name, items, bundleId, time) => handleSaveProtocolCycleBundle(cycleId, name, items, bundleId, time));
  ipcMain.handle('protocol:cycles:bundle:completion', (_event, date, cycleId, bundleId, completed) => handleSetProtocolCycleBundleCompletion(date, cycleId, bundleId, completed));
  ipcMain.handle('protocol:cycles:bundle:commit', (_event, date, cycleId, bundleId) => handleCommitCycleBundle(date, cycleId, bundleId));
  ipcMain.handle('protocol:membership', (_event, file, date, selected) => handleSetProtocolMembership(file, date, selected));
  ipcMain.handle('protocol:frequency', (_event, file, frequency) => handleSetProtocolFrequency(file, frequency));
  ipcMain.handle('protocol:create', (_event, name, category, timing, frequency, description, date) => handleCreateProtocolItem(name, category, timing, frequency, description, date));
  ipcMain.handle('habits:toggle', (_event, file, date) => handleToggleHabit(file, date));
  ipcMain.handle('habits:create', (_event, name, frequency, color) => handleCreateHabit(name, frequency, color));
  ipcMain.handle('habits:color', (_event, file, color) => handleSetHabitColor(file, color));
  ipcMain.handle('todoist:filters', handleGetTodoistFilters);
  ipcMain.handle('todoist:list', handleGetTasks);
  ipcMain.handle('todoist:projects', handleListTodoistProjects);
  ipcMain.handle('todoist:sections', (_event, projectId) => handleListTodoistSections(projectId));
  ipcMain.handle('todoist:create', (_event, task) => handleCreateTask(task));
  ipcMain.handle('todoist:update', (_event, id, task) => handleUpdateTodoistTask(id, task));
  ipcMain.handle('todoist:complete', (_event, id) => handleCompleteTask(id));
  ipcMain.handle('wrike:list', handleListWrikeTasks);
  ipcMain.handle('servicenow:list', handleListServiceNowTasks);
  ipcMain.handle('hevy:workouts', handleListHevyWorkouts);
  ipcMain.handle('hevy:cache', handleGetCachedHevyWorkouts);
  ipcMain.handle('whoop:connect', async () => { const result = await handleWhoopConnect(); return { connected: result.connected, config: publicConfig(result.config) }; });
  ipcMain.handle('whoop:summary', handleWhoopSummary);
  ipcMain.handle('weight:list', handleListWeightReadings);
  ipcMain.handle('weight:import-garmin', handleImportGarminWeightCsv);
  ipcMain.handle('dexa:list', handleListDexaScans);
  ipcMain.handle('dexa:choose-report', (_event, date) => handleChooseDexaReport(date));
  ipcMain.handle('dexa:save', (_event, scan) => handleSaveDexaScan(scan));
  ipcMain.handle('obsidian-tasks:list', handleListObsidianTasks);
  ipcMain.handle('obsidian-tasks:properties', (_event, file, line, text, dueDate, priority) => handleUpdateObsidianTaskProperties(file, line, text, dueDate, priority));
  ipcMain.handle('obsidian-tasks:complete', (_event, file, line, text) => handleToggleObsidianTask(file, line, text));
  ipcMain.handle('vault:open-note', (_event, file) => handleOpenNote(file));
  ipcMain.handle('tasks:open-native', (_event, source, id) => handleOpenNativeTask(source, id));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1260,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: '#f5f5f7',
    title: 'Daybook',
    icon: APP_ICON,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(nativeImage.createFromPath(APP_ICON));
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
