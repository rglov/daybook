const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DAILY_QUOTES = [
  'Make room for the kind of day you want to remember.',
  'Small steps count, especially on ordinary days.',
  'Give your attention to the next right thing.',
  'You can begin again without starting over.',
  'A little space can make a new idea possible.',
  'Notice what is already moving in the right direction.',
  'Let today be shaped by what matters most.',
  'Rest is part of the work of becoming well.',
  'Start where you are, and let the next step be enough.',
  'A steady pace can carry you a long way.'
];

const state = {
  config: null,
  date: localDateString(new Date()),
  day: { plan: [], selectedWork: [], calendarChecks: {}, morning: [], evening: [], journal: '' },
  habits: [],
  protocolItems: [],
  committedProtocolPaths: [],
  committedProtocolTimings: {},
  committedProtocolFrequencies: {},
  committedProtocolName: '',
  committedProtocolTime: '',
  protocolBundles: [],
  protocolCycles: [],
  protocolCalendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedProtocolCycle: '',
  protocolCycleDraft: new Map(),
  editingProtocolBundleId: '',
  protocolCycleBundleTime: '08:00',
  editingProtocolCycleId: null,
  meetingNotes: [],
  people: [],
  selectedPerson: null,
  personAssociations: { meetings: [], tasks: [], projects: [] },
  personAssociationFilter: 'all',
  personTaskUrgencyFilter: 'all',
  personTaskSourceFilter: 'all',
  showStarredMeetingsOnly: false,
  projects: [],
  activeProjectFilter: 'active',
  editingProject: null,
  selectedProject: null,
  activeProjectTaskFocus: 'do',
  projectTaskFilter: 'all',
  projectTaskDraft: new Set(),
  meetingMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedMeetingDate: '',
  meetingCalendarEvents: [],
  meetingCalendarEventsMonth: '',
  meetingCalendarEventsRequestedMonth: '',
  activeMeetingNote: null,
  selectedProtocolBundle: '',
  hevyWorkouts: [],
  workoutWeekOffset: 0,
  workoutPlanDate: '',
  hevyConnected: false,
  hevyError: '',
  hevyCachedAt: '',
  hevyFromCache: false,
  hevyLoaded: false,
  hevyLoading: false,
  calendarEvents: [],
  calendarLoading: false,
  calendarSupported: true,
  calendarAccessDenied: false,
  calendarError: '',
  tasksByQuadrant: { do: [], schedule: [], delegate: [], later: [] },
  collapsedTodoistProjects: new Set(),
  todoistDueToday: [],
  obsidianTasks: [],
  reminders: [],
  wrikeTasks: [],
  serviceNowTasks: [],
  remindersSupported: true,
  connected: false,
  filtersConfigured: false,
  notePath: '',
  noteBlock: '',
  activeView: 'today',
  activeTaskSource: 'all',
  activeUnifiedQuadrant: 'do',
  unifiedTasks: [],
  activeTaskPropertyEdit: null,
  activeTaskCreateSource: '',
  activeQuadrant: 'do',
  saveTimer: null,
  meetingSaveTimer: null,
  toastTimer: null,
  activeTimeblockIndex: null
};

function localDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function applyAppearance(appearance = state.config?.appearance || {}) {
  const mode = ['light', 'dark', 'system'].includes(appearance.mode) ? appearance.mode : 'system';
  const color = ['blue', 'violet', 'green', 'rose', 'amber'].includes(appearance.color) ? appearance.color : 'blue';
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  const colorMode = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  document.documentElement.dataset.colorMode = colorMode;
  document.documentElement.dataset.colorTheme = color;
  document.documentElement.style.colorScheme = colorMode;
}

function compactTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function prettyDate(value, options = { weekday: 'long', month: 'long', day: 'numeric' }) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, options);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add('hidden'), 2800);
}

function setSaveStatus(status, text) {
  const el = $('#save-status');
  el.classList.toggle('saving', status === 'saving');
  el.classList.toggle('error', status === 'error');
  el.textContent = text;
}

function renderPlan() {
  renderTodayPlan();
}

function streakFor(dates) {
  const set = new Set(dates);
  const cursor = new Date(`${state.date}T12:00:00`);
  if (!set.has(state.date)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (set.has(localDateString(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function todayWorkTasks() {
  return state.day.selectedWork || [];
}

const DAY_START_MINUTES = 5 * 60;
const DAY_END_MINUTES = 24 * 60;
const TIMELINE_HOUR_HEIGHT = 64;

function timeStringToMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function minutesToTimeString(value) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function formatClock(value) {
  const [hour, minute] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function timeblockConflict(start, duration, excludeIndex = -1) {
  const end = start + duration;
  for (const [index, task] of todayWorkTasks().entries()) {
    if (index === excludeIndex || !task.timeBlock) continue;
    const otherStart = timeStringToMinutes(task.timeBlock.start);
    if (Number.isFinite(otherStart) && intervalsOverlap(start, end, otherStart, otherStart + Number(task.timeBlock.duration || 30))) {
      return `This overlaps “${task.content || task.text || 'another task'}”.`;
    }
  }
  for (const item of state.calendarEvents) {
    if (item.allDay || !item.start || !item.end) continue;
    const eventStart = new Date(item.start);
    const eventEnd = new Date(item.end);
    const startMinute = eventStart.getHours() * 60 + eventStart.getMinutes();
    const endMinute = eventEnd.getHours() * 60 + eventEnd.getMinutes();
    if (intervalsOverlap(start, end, startMinute, endMinute)) return `This overlaps “${item.title || 'a calendar event'}”.`;
  }
  return '';
}

function calendarEventKey(event) {
  const identifier = event.eventIdentifier || event.calendarItemExternalIdentifier || event.title || 'event';
  return `${event.calendarIdentifier || event.calendar || 'calendar'}:${identifier}:${event.start || ''}`;
}

function firstOpenTime(duration = 30, excludeIndex = -1) {
  for (let start = 9 * 60; start + duration <= DAY_END_MINUTES; start += 30) {
    if (!timeblockConflict(start, duration, excludeIndex)) return minutesToTimeString(start);
  }
  return '09:00';
}

function saveTimeBlock(index, startValue, durationValue) {
  const task = todayWorkTasks()[index];
  if (!task) return false;
  const start = timeStringToMinutes(startValue);
  const duration = Number(durationValue);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < DAY_START_MINUTES || start + duration > DAY_END_MINUTES) {
    $('#timeblock-status').textContent = 'Choose a time between 6:00 AM and 10:00 PM.';
    return false;
  }
  const conflict = timeblockConflict(start, duration, index);
  if (conflict) {
    $('#timeblock-status').textContent = conflict;
    return false;
  }
  task.timeBlock = { start: startValue, duration };
  $('#timeblock-modal').classList.add('hidden');
  renderTodayPlan();
  scheduleSave();
  showToast('Task added to your timeline.');
  return true;
}

function openTimeblockModal(index) {
  const task = todayWorkTasks()[index];
  if (!task) return;
  state.activeTimeblockIndex = index;
  $('#timeblock-task-name').textContent = task.content || task.text || task.title || 'Selected task';
  $('#timeblock-start').value = task.timeBlock?.start || firstOpenTime(Number(task.timeBlock?.duration || 30), index);
  $('#timeblock-duration').value = String(task.timeBlock?.duration || 30);
  $('#timeblock-status').textContent = '';
  $('#timeblock-save').textContent = task.timeBlock ? 'Update time block' : 'Add to timeline';
  $('#timeblock-modal').classList.remove('hidden');
}

function renderTodayPlan() {
  const status = $('#calendar-status');
  const allDayList = $('#all-day-event-list');
  const timeline = $('#day-timeline');
  const events = state.calendarEvents;
  $('#calendar-event-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  if (!state.calendarSupported) {
    status.innerHTML = '<div class="agenda-empty">Apple Calendar is available on macOS.</div>';
  } else if (state.calendarAccessDenied) {
    status.innerHTML = '<div class="agenda-empty">Allow Daybook to read events in <strong>System Settings → Privacy &amp; Security → Calendars</strong>, then return and try again.<div class="calendar-access-actions"><button class="button secondary calendar-access-button" data-calendar-action="request">Request Calendar Access</button><button class="button secondary calendar-access-button" data-calendar-action="settings">Open Calendar Privacy Settings</button><button class="text-button" data-calendar-action="retry">Try again</button></div></div>';
  } else if (!state.config.calendarEnabled) {
    status.innerHTML = '<div class="agenda-empty">Daybook reads events from your calendars to help shape today’s plan.<button class="button secondary calendar-access-button" data-calendar-action="request">Request Calendar Access</button></div>';
  } else if (state.calendarLoading) {
    status.innerHTML = '<div class="agenda-empty">Loading calendar…</div>';
  } else if (state.calendarError) {
    status.innerHTML = `<div class="agenda-empty">${escapeHtml(state.calendarError)}<div class="calendar-access-actions"><button class="text-button" data-calendar-action="retry">Try again</button></div></div>`;
  } else {
    status.innerHTML = '';
  }
  status.classList.toggle('hidden', !status.innerHTML);

  allDayList.innerHTML = events.map((item, index) => ({ item, index })).filter(({ item }) => item.allDay).map(({ item, index }) => `<article class="all-day-event ${state.day.calendarChecks?.[calendarEventKey(item)] ? 'is-complete' : ''}"><input class="calendar-event-check" type="checkbox" data-calendar-check="${index}" ${state.day.calendarChecks?.[calendarEventKey(item)] ? 'checked' : ''} aria-label="Mark ${escapeHtml(item.title || 'event')} complete"><div><strong>${escapeHtml(item.title || 'Untitled event')}</strong><small>${escapeHtml(item.calendar || '')}</small></div><button class="agenda-event-note" data-create-meeting="${index}" title="Create meeting note">＋ Note</button></article>`).join('');

  const timelineHours = (DAY_END_MINUTES - DAY_START_MINUTES) / 60;
  timeline.style.height = `${timelineHours * TIMELINE_HOUR_HEIGHT}px`;
  const hourMarkers = Array.from({ length: timelineHours + 1 }, (_, index) => `<div class="timeline-hour" style="top:${index * TIMELINE_HOUR_HEIGHT}px"><span>${formatClock(minutesToTimeString(DAY_START_MINUTES + index * 60))}</span></div>`).join('');
  const scheduledBlocks = [];
  events.map((item, index) => ({ item, index })).filter(({ item }) => !item.allDay && item.start && item.end).forEach(({ item, index }) => {
    const startDate = new Date(item.start); const endDate = new Date(item.end);
    const start = startDate.getHours() * 60 + startDate.getMinutes();
    const end = endDate.getHours() * 60 + endDate.getMinutes();
    if (end <= DAY_START_MINUTES || start >= DAY_END_MINUTES) return;
    const clippedStart = Math.max(start, DAY_START_MINUTES); const clippedEnd = Math.min(end, DAY_END_MINUTES);
    const top = (clippedStart - DAY_START_MINUTES) / 60 * TIMELINE_HOUR_HEIGHT;
    const height = Math.max(28, (clippedEnd - clippedStart) / 60 * TIMELINE_HOUR_HEIGHT);
    const completed = Boolean(state.day.calendarChecks?.[calendarEventKey(item)]);
    scheduledBlocks.push({ start: clippedStart, end: clippedStart + Math.max(clippedEnd - clippedStart, 28 / TIMELINE_HOUR_HEIGHT * 60), top, height, markup: `<article class="timeline-block calendar-block ${completed ? 'is-complete' : ''}" style="__TIMELINE_LAYOUT__" title="${escapeHtml(item.calendar || '')}"><div class="calendar-event-heading"><input class="calendar-event-check" type="checkbox" data-calendar-check="${index}" ${completed ? 'checked' : ''} aria-label="Mark ${escapeHtml(item.title || 'event')} complete"><strong>${escapeHtml(item.title || 'Untitled event')}</strong></div><span class="timeline-block-time">${formatClock(minutesToTimeString(start))}–${formatClock(minutesToTimeString(end))}</span><small>${escapeHtml(item.calendar || '')}</small><button class="agenda-event-note" data-create-meeting="${index}" title="Create meeting note">＋ Note</button></article>` });
  });

  const tasks = todayWorkTasks();
  tasks.map((task, index) => ({ task, index })).filter(({ task }) => task.timeBlock).forEach(({ task, index }) => {
    const start = timeStringToMinutes(task.timeBlock.start); const duration = Number(task.timeBlock.duration || 30);
    if (!Number.isFinite(start) || start < DAY_START_MINUTES || start >= DAY_END_MINUTES) return;
    const top = (start - DAY_START_MINUTES) / 60 * TIMELINE_HOUR_HEIGHT;
    const height = Math.max(28, duration / 60 * TIMELINE_HOUR_HEIGHT);
    const title = task.content || task.text || task.title || 'Selected task';
    scheduledBlocks.push({ start, end: start + Math.max(duration, 28 / TIMELINE_HOUR_HEIGHT * 60), top, height, markup: `<article class="timeline-block task-timeblock" draggable="true" data-drag-task="${index}" style="__TIMELINE_LAYOUT__" title="${escapeHtml(title)} · ${formatClock(task.timeBlock.start)} for ${duration} minutes"><input type="checkbox" ${task.source === 'todoist' ? `data-day-todoist="${escapeHtml(task.id)}"` : task.source === 'obsidian' ? `data-day-obsidian-file="${escapeHtml(task.relativePath)}" data-day-obsidian-line="${Number(task.line) || 0}" data-day-obsidian-text="${escapeHtml(title)}"` : `data-day-reminder="${escapeHtml(task.id)}"`} aria-label="Complete ${escapeHtml(title)}"><div class="timeline-task-copy"><strong>${escapeHtml(title)}</strong></div><button type="button" class="timeblock-edit" data-schedule-task="${index}" aria-label="Edit time block">⋯</button><button type="button" class="timeblock-remove" data-unschedule-task="${index}" aria-label="Remove time block">×</button></article>` });
  });
  const scheduledProtocols = scheduledProtocolBundles(state.date);
  for (const entry of scheduledProtocols) {
    const start = timeStringToMinutes(entry.bundle.time || '08:00');
    if (!Number.isFinite(start) || start < DAY_START_MINUTES || start >= DAY_END_MINUTES) continue;
    const top = (start - DAY_START_MINUTES) / 60 * TIMELINE_HOUR_HEIGHT;
    const { cycle, bundle, items } = entry;
    const time = bundle.time || '08:00';
    const height = 44;
    const bundleComplete = Array.isArray(bundle.completedDates) && bundle.completedDates.includes(state.date);
    const itemNames = items.map((item) => item.name || item.relativePath?.split('/').at(-1)?.replace(/\.md$/i, '') || 'Wellness item').join(', ');
    const label = bundle.name || 'Protocol bundle';
    const markup = `<article class="timeline-block protocol-timeblock ${bundleComplete ? 'is-complete' : ''}" style="__TIMELINE_LAYOUT__" title="${escapeHtml(cycle.name)} · ${escapeHtml(label)} · ${formatClock(time)} · ${escapeHtml(itemNames)}"><input type="checkbox" data-protocol-bundle-complete="true" data-protocol-cycle-id="${escapeHtml(cycle.id)}" data-protocol-bundle-id="${escapeHtml(bundle.id)}" ${bundleComplete ? 'checked' : ''} aria-label="Mark ${escapeHtml(label)} protocol complete"><div class="protocol-timeblock-copy"><strong>${escapeHtml(label)}</strong><span class="timeline-block-time">${formatClock(time)} · ${items.length} ${items.length === 1 ? 'item' : 'items'}</span></div></article>`;
    scheduledBlocks.push({ start, end: start + height / TIMELINE_HOUR_HEIGHT * 60, top, height, markup });
  }
  scheduledBlocks.sort((a, b) => a.start - b.start || a.end - b.end);
  const blockClusters = [];
  for (const block of scheduledBlocks) {
    let cluster = blockClusters.at(-1);
    if (!cluster || block.start >= cluster.end) blockClusters.push(cluster = { end: block.end, blocks: [] });
    cluster.end = Math.max(cluster.end, block.end);
    cluster.blocks.push(block);
  }
  const timelineItems = blockClusters.flatMap((cluster) => {
    const laneEnds = [];
    for (const block of cluster.blocks) {
      let lane = laneEnds.findIndex((end) => end <= block.start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = block.end;
      block.lane = lane;
    }
    const laneCount = laneEnds.length;
    return cluster.blocks.map((block) => {
      const gap = 6;
      const lanePercent = 100 * block.lane / laneCount;
      const layout = `top:${block.top}px;height:${block.height}px;left:calc(12px + ${lanePercent}% - ${24 * block.lane / laneCount}px + ${block.lane * gap}px);right:auto;width:calc((100% - 24px - ${(laneCount - 1) * gap}px) / ${laneCount})`;
      return block.markup.replace('__TIMELINE_LAYOUT__', layout);
    });
  }).join('');
  const emptyTimeline = !events.some((item) => !item.allDay) && !tasks.some((task) => task.timeBlock) && !scheduledProtocols.length
    ? '<div class="timeline-empty">No timed events or scheduled tasks yet. Drag a task here or use Schedule.</div>' : '';
  timeline.innerHTML = `${hourMarkers}${emptyTimeline}${timelineItems}`;

  const unscheduled = tasks.map((task, index) => ({ task, index })).filter(({ task }) => !task.timeBlock);
  $('#day-work-count').textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  $('#unscheduled-task-count').textContent = String(unscheduled.length);
  const workRows = unscheduled.map(({ task, index }) => {
    const title = task.content || task.text || task.title || 'Selected task';
    const source = task.source === 'todoist' ? `Todoist${task.projectName ? ` · ${task.projectName}` : ''}`
      : task.source === 'obsidian' ? `Obsidian · ${task.fileName || task.relativePath}`
        : `Apple Reminders${task.list ? ` · ${task.list}` : ''}`;
    const completion = task.source === 'todoist'
      ? `data-day-todoist="${escapeHtml(task.id)}"`
      : task.source === 'obsidian'
        ? `data-day-obsidian-file="${escapeHtml(task.relativePath)}" data-day-obsidian-line="${Number(task.line) || 0}" data-day-obsidian-text="${escapeHtml(title)}"`
        : `data-day-reminder="${escapeHtml(task.id)}"`;
    const dueDate = task.due?.string || task.due?.date || task.dueDate || '';
    const openAttrs = task.source === 'obsidian' ? `data-open-native-task="obsidian" data-task-file="${escapeHtml(task.relativePath)}"` : `data-open-native-task="${task.source}" data-task-id="${escapeHtml(task.id)}"`;
    const openLabel = task.source === 'todoist' ? 'Todoist' : task.source === 'reminder' ? 'Apple Reminders' : 'Obsidian';
    return `<div class="agenda-task unscheduled-task" draggable="true" data-drag-task="${index}"><input type="checkbox" ${completion} aria-label="Complete ${escapeHtml(title)}"><span class="agenda-task-copy"><span>${escapeHtml(title)}</span><small>${escapeHtml(source)}${dueDate ? ` · Due ${escapeHtml(String(dueDate).slice(0, 10))}` : ''}</small></span><button class="task-schedule-button" type="button" data-schedule-task="${index}">Schedule</button><button class="task-open-link" type="button" ${openAttrs} aria-label="Open ${escapeHtml(title)} in ${openLabel}" title="Open in ${openLabel}">↗</button><button type="button" class="today-remove-task" data-remove-selected="${index}" aria-label="Remove ${escapeHtml(title)} from today">×</button></div>`;
  });
  $('#unscheduled-task-list').innerHTML = workRows.join('') || (tasks.length ? '<div class="agenda-empty">All selected tasks have a place in your day.</div>' : '<div class="agenda-empty">Select tasks from the Tasks page to add them here.</div>');
}

function workSelectionKey(item) {
  if (item.source === 'todoist') return `todoist:${item.id}`;
  if (item.source === 'reminder') return `reminder:${item.id}`;
  return `obsidian:${item.relativePath}:${String(item.text || '').trim()}`;
}

function workSelection(source, task) {
  if (source === 'todoist') return { source, id: String(task.id), content: task.content, projectName: task.projectName || '', due: task.due || null };
  if (source === 'reminder') return { source, id: String(task.id), text: task.title, list: task.list, dueDate: task.dueDate || '' };
  return { source, relativePath: task.relativePath, line: task.line, text: task.text, fileName: task.fileName };
}

function isSelectedForToday(item) {
  const key = workSelectionKey(item);
  return (state.day.selectedWork || []).some((selected) => workSelectionKey(selected) === key);
}

function toggleWorkSelection(source, task) {
  state.day.selectedWork ||= [];
  const selected = workSelection(source, task);
  const key = workSelectionKey(selected);
  const index = state.day.selectedWork.findIndex((item) => workSelectionKey(item) === key);
  if (index >= 0) state.day.selectedWork.splice(index, 1);
  else state.day.selectedWork.push(selected);
  renderTasks();
  renderObsidianTasks();
  renderReminders();
  renderTodaySelectedTasks();
  renderTodayPlan();
  scheduleSave();
}

function removeWorkSelection(source, task) {
  if (!state.day.selectedWork?.length) return;
  const key = workSelectionKey(workSelection(source, task));
  state.day.selectedWork = state.day.selectedWork.filter((item) => workSelectionKey(item) !== key);
  renderTasks();
  renderObsidianTasks();
  renderReminders();
  renderTodaySelectedTasks();
  renderTodayPlan();
  scheduleSave();
}

function renderTasks() {
  const quadrants = ['do', 'schedule', 'delegate', 'later'];
  const total = quadrants.reduce((sum, key) => sum + (state.tasksByQuadrant[key] || []).length, 0);
  $('#matrix-task-count').textContent = `${total} task${total === 1 ? '' : 's'}`;
  const ready = state.connected && state.filtersConfigured;
  $('#work-category-tabs').classList.toggle('hidden', !ready);
  $('#todoist-task-list').classList.toggle('hidden', !ready);
  $('#matrix-empty').classList.toggle('hidden', ready);
  $('#matrix-empty').textContent = !state.connected
    ? 'Connect Todoist in Settings to see your saved task lists.'
    : 'Connect Todoist in Settings to load your tasks.';
  $('#todoist-subtitle').textContent = ready ? 'Tasks grouped by project and urgency.' : 'Connect Todoist to load your tasks.';
  if (!ready) return;
  for (const key of quadrants) {
    const tasks = state.tasksByQuadrant[key] || [];
    $(`[data-count="${key}"]`).textContent = String(tasks.length);
    const tab = $(`[data-work-quadrant="${key}"]`);
    tab.classList.toggle('active', key === state.activeQuadrant);
    tab.setAttribute('aria-selected', String(key === state.activeQuadrant));
  }
  const tasks = state.tasksByQuadrant[state.activeQuadrant] || [];
  if (!tasks.length) {
    $('#todoist-task-list').innerHTML = '<div class="todoist-empty-list">Nothing in this list. Enjoy the breathing room.</div>';
    return;
  }
  const groups = new Map();
  for (const task of tasks) {
    const projectName = task.projectName || 'No project';
    if (!groups.has(projectName)) groups.set(projectName, []);
    groups.get(projectName).push(task);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  $('#todoist-task-list').innerHTML = sortedGroups.map(([projectName, projectTasks]) => {
    const collapsed = state.collapsedTodoistProjects.has(projectName);
    return `
    <section class="task-project-group ${collapsed ? 'collapsed' : ''}">
      <button class="task-project-heading" type="button" data-toggle-todoist-project="${escapeHtml(projectName)}" aria-expanded="${!collapsed}"><span class="task-project-disclosure" aria-hidden="true">${collapsed ? '›' : '⌄'}</span><h3>${escapeHtml(projectName)}</h3><span class="task-project-count">${projectTasks.length}</span></button>
      <div class="task-project-rows" ${collapsed ? 'hidden' : ''}>${projectTasks.map((task) => {
        const due = task.due?.date ? `<span class="matrix-task-meta">${escapeHtml(task.due.string || task.due.date)}</span>` : '';
        const priority = task.priority > 1 ? `<span class="matrix-task-priority">P${5 - task.priority}</span>` : '';
        const selected = isSelectedForToday(workSelection('todoist', task));
        return `<div class="matrix-task-row ${task.checked ? 'done' : ''}"><button class="select-today-button ${selected ? 'selected' : ''}" data-select-today data-select-source="todoist" data-select-id="${escapeHtml(task.id)}" aria-pressed="${selected}">${selected ? '✓ Today' : '+ Today'}</button><span class="matrix-task-copy"><span class="matrix-task-name">${escapeHtml(task.content)}</span><span class="matrix-task-details">${due}${priority}</span></span><span class="task-origin-tag todoist" title="Todoist">Todoist</span><button class="text-button" type="button" data-edit-task-properties="todoist" data-task-id="${escapeHtml(task.id)}">Edit</button><button class="task-open-link" type="button" data-open-native-task="todoist" data-task-id="${escapeHtml(task.id)}" aria-label="Open ${escapeHtml(task.content)} in Todoist" title="Open in Todoist">↗</button><input type="checkbox" data-task="${escapeHtml(task.id)}" aria-label="Complete ${escapeHtml(task.content)}"></div>`;
      }).join('')}</div>
    </section>`;
  }).join('');
}

function renderObsidianTasks() {
  const list = $('#obsidian-task-list');
  const count = state.obsidianTasks.length;
  $('#obsidian-task-count').textContent = `${count} task${count === 1 ? '' : 's'}`;
  $('#nav-work-count').textContent = String(count + state.reminders.length + Object.values(state.tasksByQuadrant).reduce((sum, tasks) => sum + tasks.length, 0));
  $('#obsidian-task-empty').classList.toggle('hidden', count > 0);
  list.classList.toggle('hidden', count === 0);
  const groups = new Map();
  for (const task of state.obsidianTasks) {
    const name = task.fileName || 'Untitled note';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(task);
  }
  list.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(([name, tasks]) => `
    <section class="task-list-group">
      <div class="task-list-group-heading"><strong>${escapeHtml(name)}</strong><span>${tasks.length}</span></div>
      ${tasks.map((task) => {
        const selection = workSelection('obsidian', task);
        const selected = isSelectedForToday(selection);
        const priority = normalizedTaskPriority(task, 'obsidian');
        const priorityLabel = ({ 1: 'Normal', 2: 'Medium', 3: 'High', 4: 'Urgent' })[priority] || 'Normal';
        const due = task.dueDate ? `<time class="task-property-chip">${escapeHtml(task.dueDate)}</time>` : '';
        return `<div class="obsidian-task-row"><button class="select-today-button ${selected ? 'selected' : ''}" data-select-today data-select-source="obsidian" data-select-file="${escapeHtml(task.relativePath)}" data-select-text="${escapeHtml(task.text)}" aria-pressed="${selected}">${selected ? '✓ Today' : '+ Today'}</button><input type="checkbox" data-obsidian-file="${escapeHtml(task.relativePath)}" data-obsidian-line="${task.line}" data-obsidian-text="${escapeHtml(task.text)}" aria-label="Complete ${escapeHtml(task.text)}"><span class="obsidian-task-text">${escapeHtml(task.displayText || task.text)}</span><span class="task-origin-tag obsidian" title="Obsidian">Obsidian</span>${due}<span class="aggregate-task-priority priority-${priority}">${priorityLabel}</span><button class="text-button" type="button" data-edit-task-properties="obsidian" data-task-file="${escapeHtml(task.relativePath)}" data-task-line="${task.line}" data-task-text="${escapeHtml(task.text)}">Edit</button><button class="task-open-link" type="button" data-open-native-task="obsidian" data-task-file="${escapeHtml(task.relativePath)}" aria-label="Open ${escapeHtml(task.displayText || task.text)} in Obsidian" title="Open in Obsidian">↗</button></div>`;
      }).join('')}
    </section>`).join('');
}

function renderReminders() {
  const list = $('#reminder-task-list');
  const reminders = state.reminders;
  $('#reminder-task-count').textContent = `${reminders.length} reminder${reminders.length === 1 ? '' : 's'}`;
  $('#reminder-task-empty').classList.toggle('hidden', reminders.length > 0);
  list.classList.toggle('hidden', reminders.length === 0);
  $('#reminder-task-empty').textContent = state.remindersSupported ? 'No open Apple Reminders found.' : 'Apple Reminders is available on macOS.';
  const groups = new Map();
  for (const reminder of reminders) {
    const name = reminder.list || 'Reminders';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(reminder);
  }
  list.innerHTML = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(([name, items]) => `
    <section class="task-list-group">
      <div class="task-list-group-heading"><strong>${escapeHtml(name)}</strong><span>${items.length}</span></div>
      ${items.map((reminder) => {
        const selected = isSelectedForToday(workSelection('reminder', reminder));
        const priority = normalizedTaskPriority(reminder, 'reminder');
        const priorityLabel = ({ 1: 'Normal', 2: 'Medium', 3: 'High', 4: 'Urgent' })[priority] || 'Normal';
        return `<div class="obsidian-task-row"><button class="select-today-button ${selected ? 'selected' : ''}" data-select-today data-select-source="reminder" data-select-id="${escapeHtml(reminder.id)}" aria-pressed="${selected}">${selected ? '✓ Today' : '+ Today'}</button><input type="checkbox" data-reminder="${escapeHtml(reminder.id)}" aria-label="Complete ${escapeHtml(reminder.title)}"><span class="obsidian-task-text">${escapeHtml(reminder.title)}</span><span class="task-origin-tag reminders" title="Apple Reminders">Apple Reminders</span>${reminder.dueDate ? `<time class="task-property-chip">${escapeHtml(reminder.dueDate.slice(0, 10))}</time>` : ''}<span class="aggregate-task-priority priority-${priority}">${priorityLabel}</span><button class="text-button" type="button" data-edit-task-properties="reminder" data-task-id="${escapeHtml(reminder.id)}">Edit</button><button class="task-open-link" type="button" data-open-native-task="reminder" data-task-id="${escapeHtml(reminder.id)}" aria-label="Open ${escapeHtml(reminder.title)} in Apple Reminders" title="Open in Apple Reminders">↗</button></div>`;
      }).join('')}
    </section>`).join('');
}

function renderTaskSourceTabs() {
  const todoistCount = state.config?.modules?.todoist === false
    ? 0
    : new Set(Object.values(state.tasksByQuadrant).flat().map((task) => String(task.id))).size;
  const counts = { todoist: todoistCount, obsidian: state.obsidianTasks.length, reminders: state.reminders.length, wrike: state.wrikeTasks.length, serviceNow: state.serviceNowTasks.length };
  counts.all = Object.values(counts).reduce((sum, value) => sum + value, 0);
  for (const [source, count] of Object.entries(counts)) {
    const badge = $(`[data-task-source-count="${source}"]`);
    if (badge) badge.textContent = String(count);
  }
  const todoistTab = $('[data-task-source="todoist"]');
  if (todoistTab) todoistTab.classList.toggle('hidden', state.config?.modules?.todoist === false);
  for (const [source, module] of [['wrike', 'wrike'], ['serviceNow', 'serviceNow']]) {
    const tab = $(`[data-task-source="${source}"]`);
    if (tab) tab.classList.toggle('hidden', state.config?.modules?.[module] === false);
    if (state.activeTaskSource === source && state.config?.modules?.[module] === false) state.activeTaskSource = 'all';
  }
  if (state.activeTaskSource === 'todoist' && state.config?.modules?.todoist === false) state.activeTaskSource = 'all';
  $$('#task-source-tabs [data-task-source]').forEach((button) => {
    const active = button.dataset.taskSource === state.activeTaskSource;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-task-source-panel]').forEach((panel) => {
    const visible = panel.id === 'all-tasks-focus';
    panel.classList.toggle('hidden', !visible);
  });
  $('#all-tasks-focus').classList.remove('hidden');
}

function setTaskSource(source) {
  state.activeTaskSource = source;
  renderTaskSourceTabs();
  renderUnifiedTasks();
}

function normalizedTaskDueDate(task, source) {
  if (source === 'todoist') return String(task.due?.date || '').slice(0, 10);
  return String(task.dueDate || '').slice(0, 10);
}

function normalizedTaskPriority(task, source) {
  if (source === 'todoist') return Number(task.priority || 1);
  return Math.min(4, Math.max(1, Number(task.priority || 1)));
}

function taskUrgency(dueDate) {
  if (!dueDate) return false;
  const today = new Date(`${localDateString(new Date())}T12:00:00`);
  const due = new Date(`${dueDate}T12:00:00`);
  const days = Math.round((due - today) / 86400000);
  return days <= 7;
}

function renderUnifiedTasks() {
  const uniqueTodoist = new Map();
  for (const task of Object.values(state.tasksByQuadrant).flat()) uniqueTodoist.set(String(task.id), task);
  const linkedProjects = new Map();
  for (const project of state.projects || []) {
    for (const link of project.taskLinks || []) {
      const key = projectTaskKey(link);
      if (!linkedProjects.has(key)) linkedProjects.set(key, project.title);
    }
  }
  const tasks = [
    ...[...uniqueTodoist.values()].map((task) => ({ source: 'todoist', id: String(task.id), title: task.content, projectName: linkedProjects.get(projectTaskKey({ source: 'todoist', id: String(task.id) })) || task.projectName || 'No project', detail: task.projectName || 'Todoist', dueDate: normalizedTaskDueDate(task, 'todoist'), priority: normalizedTaskPriority(task, 'todoist'), task })),
    ...state.reminders.map((task) => ({ source: 'reminder', id: String(task.id), title: task.title, projectName: linkedProjects.get(projectTaskKey({ source: 'reminder', id: String(task.id) })) || task.list || 'No project', detail: task.list || 'Apple Reminders', dueDate: normalizedTaskDueDate(task, 'reminder'), priority: normalizedTaskPriority(task, 'reminder'), task })),
    ...state.obsidianTasks.map((task) => ({ source: 'obsidian', id: `${task.relativePath}:${task.line}`, title: task.displayText || task.text, projectName: linkedProjects.get(projectTaskKey({ source: 'obsidian', relativePath: task.relativePath, text: task.text })) || 'No project', detail: task.fileName || 'Obsidian', dueDate: normalizedTaskDueDate(task, 'obsidian'), priority: normalizedTaskPriority(task, 'obsidian'), task })),
    ...state.wrikeTasks.map((task) => ({ source: 'wrike', id: String(task.id), title: task.title, projectName: task.projectName || 'Wrike', detail: task.detail || 'Wrike', dueDate: task.dueDate || '', priority: normalizedTaskPriority(task, 'wrike'), task })),
    ...state.serviceNowTasks.map((task) => ({ source: 'serviceNow', id: `${task.table}:${task.id}`, title: task.title, projectName: task.projectName || 'ServiceNow', detail: task.detail || 'ServiceNow', dueDate: task.dueDate || '', priority: normalizedTaskPriority(task, 'serviceNow'), task }))
  ];
  const sourceKeys = { all: null, todoist: 'todoist', obsidian: 'obsidian', reminders: 'reminder', wrike: 'wrike', serviceNow: 'serviceNow' };
  const sourceFilter = sourceKeys[state.activeTaskSource] ?? null;
  const visibleTasks = sourceFilter ? tasks.filter((item) => item.source === sourceFilter) : tasks;
  const sourceLabels = { all: 'ALL SOURCES', todoist: 'TODOIST', obsidian: 'OBSIDIAN', reminders: 'APPLE REMINDERS', wrike: 'WRIKE', serviceNow: 'SERVICENOW' };
  $('#aggregate-task-source-label').textContent = sourceLabels[state.activeTaskSource] || 'ALL SOURCES';
  const groups = { do: [], schedule: [], delegate: [], later: [] };
  for (const item of visibleTasks) {
    const important = item.priority >= 3;
    const urgent = taskUrgency(item.dueDate);
    const group = important ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'later');
    groups[group].push(item);
  }
  for (const [group, items] of Object.entries(groups)) {
    items.sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') || b.priority - a.priority || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const count = $(`[data-unified-count="${group}"]`);
    if (count) count.textContent = String(items.length);
    const tab = $(`[data-unified-quadrant="${group}"]`);
    if (tab) {
      tab.classList.toggle('active', state.activeUnifiedQuadrant === group);
      tab.setAttribute('aria-selected', String(state.activeUnifiedQuadrant === group));
    }
  }
  state.unifiedTasks = tasks;
  const active = groups[state.activeUnifiedQuadrant] || [];
  const list = $('#aggregate-task-list');
  const empty = $('#aggregate-task-empty');
  list.classList.toggle('hidden', active.length === 0);
  empty.classList.toggle('hidden', active.length > 0);
  const emptyText = {
    do: 'No tasks are both high priority and due soon.',
    schedule: 'No high priority tasks are waiting for a later date.',
    delegate: 'No lower priority tasks are due soon.',
    later: 'No other open tasks. You are all caught up.'
  };
  const sourceEmptyLabel = { todoist: 'Todoist', obsidian: 'Obsidian', reminders: 'Apple Reminders', wrike: 'Wrike', serviceNow: 'ServiceNow' }[state.activeTaskSource];
  empty.textContent = sourceEmptyLabel && !visibleTasks.length
    ? `No ${sourceEmptyLabel} tasks to show.`
    : emptyText[state.activeUnifiedQuadrant] || 'No matching tasks.';
  const rowMarkup = new Map(active.map((item) => {
    const selection = item.source === 'todoist' ? workSelection('todoist', item.task)
      : item.source === 'reminder' ? workSelection('reminder', item.task)
        : item.source === 'obsidian' ? workSelection('obsidian', item.task) : null;
    const selected = isSelectedForToday(selection);
    const sourceLabel = ({ reminder: 'Apple Reminders', todoist: 'Todoist', obsidian: 'Obsidian', wrike: 'Wrike', serviceNow: 'ServiceNow' })[item.source];
    const sourceClass = item.source === 'reminder' ? 'reminders' : item.source === 'serviceNow' ? 'servicenow' : item.source;
    const dueText = item.dueDate ? cycleDateLabel(item.dueDate) : 'No due date';
    const priorityLabel = ({ 1: 'Normal', 2: 'Medium', 3: 'High', 4: 'Urgent' })[item.priority] || 'Normal';
    const completion = item.source === 'todoist' ? `data-aggregate-complete="todoist" data-task-id="${escapeHtml(item.id)}"`
      : item.source === 'reminder' ? `data-aggregate-complete="reminder" data-task-id="${escapeHtml(item.id)}"`
        : item.source === 'obsidian' ? `data-aggregate-complete="obsidian" data-task-file="${escapeHtml(item.task.relativePath)}" data-task-line="${item.task.line}" data-task-text="${escapeHtml(item.task.text)}"` : '';
    const canEdit = ['todoist', 'reminder', 'obsidian'].includes(item.source);
    const edit = `data-edit-task-properties="${item.source}" data-task-id="${escapeHtml(item.id)}" data-task-file="${escapeHtml(item.task.relativePath || '')}" data-task-line="${item.task.line || ''}" data-task-text="${escapeHtml(item.task.text || '')}" data-task-title="${escapeHtml(item.title)}" data-task-due="${escapeHtml(item.dueDate)}" data-task-priority="${item.priority}"`;
    const nativeId = item.source === 'wrike' ? (item.task.permalink || '') : item.source === 'serviceNow' ? `${item.task.table}:${item.task.id}` : item.id;
    return [item, `<article class="aggregate-task-row">${completion ? `<input type="checkbox" ${completion} aria-label="Complete ${escapeHtml(item.title)}">` : '<span class="task-readonly-mark" aria-hidden="true">•</span>'}<div class="aggregate-task-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div><span class="task-origin-tag ${sourceClass}">${sourceLabel}</span><span class="aggregate-task-date ${item.dueDate ? '' : 'no-date'}">${escapeHtml(dueText)}</span><span class="aggregate-task-priority priority-${item.priority}">${priorityLabel}</span>${canEdit ? `<button class="text-button aggregate-task-edit" type="button" ${edit}>Edit</button>` : ''}<button class="task-open-link" type="button" data-open-native-task="${item.source}" data-task-id="${escapeHtml(nativeId)}" aria-label="Open ${escapeHtml(item.title)} in ${sourceLabel}" title="Open in ${sourceLabel}">↗</button>${canEdit ? `<button class="select-today-button ${selected ? 'selected' : ''}" data-select-today data-select-source="${item.source}" ${item.source === 'obsidian' ? `data-select-file="${escapeHtml(item.task.relativePath)}" data-select-text="${escapeHtml(item.task.text)}"` : `data-select-id="${escapeHtml(item.id)}"`} aria-pressed="${selected}">${selected ? '✓ Today' : '+ Today'}</button>` : ''}</article>`];
  }));
  const projectGroups = new Map();
  for (const item of active) {
    const projectName = item.projectName || 'No project';
    if (!projectGroups.has(projectName)) projectGroups.set(projectName, []);
    projectGroups.get(projectName).push(item);
  }
  list.innerHTML = [...projectGroups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(([projectName, items]) => `<section class="aggregate-project-group"><header><h3>${escapeHtml(projectName)}</h3><span>${items.length}</span></header>${items.map((item) => rowMarkup.get(item)).join('')}</section>`).join('');
}

function taskPersonKey(source, task) {
  if (source === 'todoist') return `todoist:${task.id}`;
  if (source === 'reminder') return `reminder:${task.id}`;
  return `obsidian:${task.relativePath}::${task.displayText || task.title || task.text}`;
}

function renderTaskPeopleChoices(selected = []) {
  const chosen = new Set(selected);
  $('#task-people-choices').innerHTML = state.people?.length ? state.people.map((person) => `<label class="people-multi-select-option"><input type="checkbox" value="${escapeHtml(person.relativePath)}" ${chosen.has(person.relativePath) ? 'checked' : ''}><span>${escapeHtml(person.title)}</span></label>`).join('') : '<span class="meeting-people-empty">Create a person note first to assign this task.</span>';
  updateTaskPeopleSummary();
}

function updateTaskPeopleSummary() {
  const selected = $$('#task-people-choices input:checked').map((input) => state.people.find((person) => person.relativePath === input.value)?.title).filter(Boolean);
  $('#task-people-summary').textContent = selected.length ? (selected.length === 1 ? selected[0] : `${selected.length} people selected`) : 'Choose people';
}

async function openTaskProperties(source, task) {
  if (!state.people?.length) state.people = await window.daybook.listPeople().catch(() => []);
  const dueDate = normalizedTaskDueDate(task, source);
  const priority = normalizedTaskPriority(task, source);
  const title = source === 'todoist' ? task.content : source === 'reminder' ? task.title : task.displayText || task.text;
  state.activeTaskPropertyEdit = { source, task };
  const key = taskPersonKey(source, task);
  renderTaskPeopleChoices(state.people.filter((person) => (person.taskLinks || []).includes(key)).map((person) => person.relativePath));
  $('#task-properties-source').textContent = source === 'reminder' ? 'Apple Reminders' : source === 'todoist' ? 'Todoist' : 'Obsidian';
  $('#task-properties-name').textContent = title;
  $('#task-properties-date').value = dueDate;
  $('#task-properties-priority').value = String(priority);
  updateTaskFocusPreview();
  const projectField = $('#task-properties-project-field');
  const projectSelect = $('#task-properties-project');
  projectField.classList.toggle('hidden', source !== 'obsidian');
  if (source === 'obsidian') {
    const assignedProject = state.projects.find((project) => (project.taskLinks || []).some((link) => link.source === 'obsidian'
      && link.relativePath === task.relativePath
      && (link.text === task.text || link.title === (task.displayText || task.text))));
    projectSelect.innerHTML = '<option value="">No project</option>' + state.projects
      .map((project) => `<option value="${escapeHtml(project.relativePath)}">${escapeHtml(project.title)}</option>`).join('');
    projectSelect.value = assignedProject?.relativePath || '';
  }
  $('#task-properties-status').textContent = source === 'obsidian' ? 'Task details stay in Obsidian; people are linked from their person notes.' : 'Task details stay in the original app; people are linked from their person notes.';
  $('#task-properties-modal').classList.remove('hidden');
}

function updateTaskFocusPreview() {
  const dueDate = $('#task-properties-date').value;
  const important = Number($('#task-properties-priority').value) >= 3;
  const urgent = taskUrgency(dueDate);
  const group = important ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'later');
  const labels = { do: 'Do first', schedule: 'Schedule', delegate: 'Delegate', later: 'Later / reconsider' };
  const urgency = urgent ? 'Urgent' : 'Not urgent';
  const importance = important ? 'Important' : 'Not important';
  const dueContext = !dueDate ? 'No due date' : urgent ? 'Due within seven days or overdue' : 'Due in more than seven days';
  $('#task-properties-focus').innerHTML = `<span class="task-focus-badge ${group}">${labels[group]}</span><span class="task-focus-copy"><strong>Falls under ${labels[group]}</strong><small>${urgency} · ${importance} · ${dueContext}</small></span>`;
}

function taskLinkMatchesObsidian(link, task) {
  return link.source === 'obsidian' && link.relativePath === task.relativePath
    && (link.text === task.text || link.title === (task.displayText || task.text));
}

async function saveObsidianTaskProject(originalTask, updatedTask, projectPath) {
  const newLink = {
    source: 'obsidian',
    relativePath: updatedTask.relativePath,
    text: updatedTask.text,
    title: updatedTask.displayText || updatedTask.text
  };
  for (const project of state.projects) {
    const previousLinks = project.taskLinks || [];
    const matched = previousLinks.some((link) => taskLinkMatchesObsidian(link, originalTask));
    const isDestination = project.relativePath === projectPath;
    if (!matched && !isDestination) continue;
    let taskLinks = previousLinks.filter((link) => !taskLinkMatchesObsidian(link, originalTask));
    if (isDestination) taskLinks.push(newLink);
    if (taskLinks.length === previousLinks.length && taskLinks.every((link, index) => link === previousLinks[index])) continue;
    await window.daybook.saveProject({
      relativePath: project.relativePath,
      title: project.title,
      status: project.status,
      priority: project.priority,
      startDate: project.startDate,
      dueDate: project.dueDate,
      overview: project.overview,
      milestones: (project.milestones || []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n'),
      taskLinks,
      people: project.people || []
    });
  }
  await loadProjects();
}

function renderTodaySelectedTasks() {
  const tasks = state.day.selectedWork || [];
  $('#due-today-total').textContent = String(tasks.length);
  const sourceCounts = new Map();
  for (const item of tasks) sourceCounts.set(item.source, (sourceCounts.get(item.source) || 0) + 1);
  $('#due-today-sources').innerHTML = [
    ['todoist', 'Todoist'], ['obsidian', 'Obsidian'], ['reminder', 'Apple']
  ].filter(([source]) => sourceCounts.has(source)).map(([source, name]) => `<span>${name}<strong>${sourceCounts.get(source)}</strong></span>`).join('');
  $('#due-today-empty').classList.toggle('hidden', tasks.length > 0);
  $('#due-today-list').classList.toggle('hidden', tasks.length === 0);
  $('#due-today-list').innerHTML = tasks.map((task, index) => {
    const source = task.source;
    const title = task.content || task.text || task.title || 'Selected task';
    const detail = source === 'todoist' ? task.projectName || 'Todoist' : source === 'reminder' ? task.list || 'Apple Reminders' : task.fileName || task.relativePath || 'Obsidian';
    const dueDate = task.due?.string || task.due?.date || task.dueDate || '';
    const attrs = source === 'todoist'
      ? `data-due-source="todoist" data-due-id="${escapeHtml(task.id)}"`
      : source === 'obsidian'
        ? `data-due-source="obsidian" data-due-file="${escapeHtml(task.relativePath)}" data-due-line="${task.line}" data-due-text="${escapeHtml(task.text)}"`
        : `data-due-source="reminder" data-due-id="${escapeHtml(task.id)}"`;
    const sourceLabel = source === 'reminder' ? 'Apple' : source === 'todoist' ? 'Todoist' : 'Obsidian';
    const sourceClass = source === 'reminder' ? 'reminders' : source;
    const openAttrs = source === 'obsidian' ? `data-open-native-task="obsidian" data-task-file="${escapeHtml(task.relativePath)}"` : `data-open-native-task="${source}" data-task-id="${escapeHtml(task.id)}"`;
    return `<div class="due-today-row"><input type="checkbox" ${attrs} aria-label="Complete ${escapeHtml(title)}"><span class="due-today-copy"><strong>${escapeHtml(title)}</strong><small><span class="task-origin-tag ${sourceClass}">${sourceLabel}</span> · ${escapeHtml(detail)}</small></span>${dueDate ? `<time class="due-today-date">${escapeHtml(String(dueDate).slice(0, 10))}</time>` : ''}<button class="task-open-link" type="button" ${openAttrs} aria-label="Open ${escapeHtml(title)} in ${sourceLabel}" title="Open in ${sourceLabel}">↗</button><button class="today-remove-task" type="button" data-remove-selected="${index}" aria-label="Remove ${escapeHtml(title)} from today">×</button></div>`;
  }).join('');
}

function removeSelectedWorkAt(index) {
  if (!state.day.selectedWork?.[index]) return;
  state.day.selectedWork.splice(index, 1);
  renderTasks();
  renderObsidianTasks();
  renderReminders();
  renderTodaySelectedTasks();
  renderTodayPlan();
  scheduleSave();
}

function updateJournalCount() {
  const words = ($('#journal-input').value.trim().match(/\S+/g) || []).length;
  $('#journal-word-count').textContent = `${words} word${words === 1 ? '' : 's'}`;
}

function renderJournalEntries() {
  const entries = state.day.journalEntries || [];
  $('#journal-entries').innerHTML = entries.map((entry, index) => `<article class="journal-entry">${entry.timestamp ? `<time>${escapeHtml(formatJournalTime(entry.timestamp))}</time><span class="journal-entry-dash">-</span>` : ''}<span class="journal-entry-content">${escapeHtml(entry.text)}${entry.tags?.length ? ` ${entry.tags.map((tag) => `#${escapeHtml(tag)}`).join(' ')}` : ''}</span><button type="button" class="journal-task-button" data-journal-task="${index}" title="Convert to Obsidian task" aria-label="Convert journal entry to Obsidian task">↗</button></article>`).join('');
}

function formatJournalTime(timestamp) {
  const [, year, month, day, hour, minute, second] = timestamp.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/) || [];
  if (!year) return '';
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function nextJournalTimestamp() {
  const now = new Date();
  const [year, month, day] = state.date.split('-').map(Number);
  const timestampDate = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds());
  const latest = (state.day.journalEntries || []).at(-1)?.timestamp;
  if (latest?.startsWith(state.date.replace(/-/g, '')) && /^\d{14}$/.test(latest)) {
    const previous = new Date(Number(latest.slice(0, 4)), Number(latest.slice(4, 6)) - 1, Number(latest.slice(6, 8)), Number(latest.slice(8, 10)), Number(latest.slice(10, 12)), Number(latest.slice(12, 14)));
    if (previous >= timestampDate) return compactTimestamp(new Date(previous.getTime() + 1000));
  }
  return compactTimestamp(timestampDate);
}

function addJournalEntry() {
  const input = $('#journal-input');
  const text = input.value.trim();
  if (!text) return;
  const tags = [...new Set($('#journal-tags').value.split(',').map((tag) => tag.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_/-]/gu, '')).filter(Boolean))];
  const timestamp = nextJournalTimestamp();
  state.day.journalEntries ||= [];
  state.day.journalEntries.push({ timestamp, text, tags });
  state.day.journal = text;
  state.day.journalTimestamp = timestamp;
  input.value = '';
  $('#journal-tags').value = '';
  renderJournalEntries();
  updateJournalCount();
  scheduleSave();
}

async function openTodoistTaskComposer(content, description = '') {
  if (state.config?.modules?.todoist === false) {
    showToast('Enable Todoist in Settings to create Todoist tasks.', true);
    return;
  }
  const form = $('#todoist-task-form');
  form.reset();
  $('#todoist-task-section').innerHTML = '<option value="">No section</option>';
  $('#todoist-task-project').innerHTML = '<option value="">Inbox</option>';
  $('#todoist-task-content').value = content.slice(0, 500);
  $('#todoist-task-description').value = description;
  $('#todoist-task-status').textContent = 'Loading projects…';
  $('#todoist-task-modal').classList.remove('hidden');
  try {
    const projects = await window.daybook.listTodoistProjects();
    const sortedProjects = [...projects].sort((a, b) => Number(Boolean(b.is_inbox_project)) - Number(Boolean(a.is_inbox_project)) || a.name.localeCompare(b.name));
    for (const project of sortedProjects) {
      if (project.is_inbox_project) continue;
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      $('#todoist-task-project').append(option);
    }
    $('#todoist-task-status').textContent = '';
  } catch (error) {
    $('#todoist-task-status').textContent = error.message;
    showToast(error.message, true);
  }
  $('#todoist-task-content').focus();
}

function renderToday() {
  $('#date-input').value = state.date;
  $('#journal-date-input').value = state.date;
  $('#journal-date-subtitle').textContent = prettyDate(state.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#date-title').textContent = prettyDate(state.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#date-subtitle').textContent = 'Make room for what matters.';
  $('#greeting').textContent = state.date === localDateString(new Date()) ? 'A new day, at your pace' : prettyDate(state.date, { weekday: 'long' });
  renderQuoteOfDay();
  $('#journal-input').value = '';
  $('#daily-note-path').textContent = state.notePath ? `↳ ${state.notePath}` : '';
  $('#journal-note-path').textContent = state.notePath ? `↳ ${state.notePath}` : '';
  renderPlan();
  renderJournalEntries();
  renderTodayPlan();
  updateJournalCount();
}

function renderQuoteOfDay() {
  const [year, month, day] = state.date.split('-').map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  const index = ((dayNumber % DAILY_QUOTES.length) + DAILY_QUOTES.length) % DAILY_QUOTES.length;
  $('#day-quote').textContent = `“${DAILY_QUOTES[index]}”`;
}

function frequencyLabel(value) {
  const normalized = normalizeProtocolFrequency(value) || value;
  if (normalized?.startsWith('days:')) {
    const selected = new Set(normalized.slice(5).split(','));
    return PROTOCOL_DAYS.filter((day) => selected.has(day.key)).map((day) => day.short).join(', ') || 'Choose days';
  }
  return ({ daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' })[normalized] || value;
}

const PROTOCOL_DAYS = [
  { key: 'mon', aliases: ['mon', 'monday'], short: 'Mon', label: 'Monday', jsDay: 1 }, { key: 'tue', aliases: ['tue', 'tues', 'tuesday'], short: 'Tue', label: 'Tuesday', jsDay: 2 },
  { key: 'wed', aliases: ['wed', 'weds', 'wednesday'], short: 'Wed', label: 'Wednesday', jsDay: 3 }, { key: 'thu', aliases: ['thu', 'thur', 'thurs', 'thursday'], short: 'Thu', label: 'Thursday', jsDay: 4 },
  { key: 'fri', aliases: ['fri', 'friday'], short: 'Fri', label: 'Friday', jsDay: 5 }, { key: 'sat', aliases: ['sat', 'saturday'], short: 'Sat', label: 'Saturday', jsDay: 6 },
  { key: 'sun', aliases: ['sun', 'sunday'], short: 'Sun', label: 'Sunday', jsDay: 0 }
];

function renderCycleWeekdaySelector(relativePath, frequency) {
  const selected = new Set(frequency.startsWith('days:') ? frequency.slice(5).split(',') : []);
  return `<div class="protocol-weekday-selector cycle-protocol-weekdays ${frequency.startsWith('days:') ? '' : 'hidden'}"><span>Take on</span><div class="protocol-weekday-options">${PROTOCOL_DAYS.map((day) => `<label><input type="checkbox" data-cycle-weekday="${escapeHtml(relativePath)}" value="${day.key}" ${selected.has(day.key) ? 'checked' : ''}>${day.short}</label>`).join('')}</div></div>`;
}

function protocolAdherence(date) {
  const scheduled = scheduledProtocolBundles(date);
  const completed = scheduled.filter(({ bundle }) => Array.isArray(bundle.completedDates) && bundle.completedDates.includes(date));
  return { scheduled, completed, total: scheduled.length, done: completed.length, ratio: scheduled.length ? completed.length / scheduled.length : null };
}

function renderProtocolCalendar() {
  const month = state.protocolCalendarMonth;
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  $('#protocol-calendar-month-label').textContent = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span class="meeting-weekday">${day}</span>`).join('');
  const dayCells = Array.from({ length: firstWeekday + daysInMonth }, (_value, index) => {
    if (index < firstWeekday) return '<span class="meeting-calendar-blank" aria-hidden="true"></span>';
    const day = index - firstWeekday + 1;
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const adherence = protocolAdherence(date);
    const future = date > localDateString(new Date());
    const heat = future || adherence.ratio === null ? 0 : adherence.ratio >= 1 ? 3 : adherence.ratio >= 0.5 ? 2 : 1;
    const selected = state.date === date;
    const detail = adherence.total ? (future ? `${adherence.total} planned` : `${adherence.done}/${adherence.total}`) : '—';
    const label = adherence.total ? (future ? `${adherence.total} bundles scheduled` : `${Math.round(adherence.ratio * 100)}% · ${adherence.done} of ${adherence.total} bundles`) : 'No scheduled bundles';
    return `<button class="protocol-calendar-day heat-${heat} ${selected ? 'selected' : ''}" type="button" data-protocol-date="${date}" aria-pressed="${selected}" title="${escapeHtml(prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))} · ${label}"><span>${day}</span><small>${detail}</small></button>`;
  }).join('');
  $('#protocol-calendar-grid').innerHTML = `${weekdayHeaders}${dayCells}`;
  const selected = protocolAdherence(state.date);
  const selectedLabel = prettyDate(state.date, { weekday: 'long', month: 'long', day: 'numeric' });
  const selectedIsFuture = state.date > localDateString(new Date());
  $('#protocol-day-title').textContent = `Expected for ${selectedLabel}`;
  $('#protocol-adherence-summary').textContent = selected.total
    ? selectedIsFuture ? `${selected.total} bundles scheduled for ${selectedLabel}` : `${selected.done} of ${selected.total} bundles completed · ${Math.round(selected.ratio * 100)}% on ${selectedLabel}`
    : `No protocol bundles scheduled for ${selectedLabel}`;
  $('#protocol-day-items').innerHTML = selected.scheduled.length ? selected.scheduled.map(({ cycle, bundle, items }) => {
    const complete = Array.isArray(bundle.completedDates) && bundle.completedDates.includes(state.date);
    const names = items.map((item) => item.name || item.relativePath?.split('/').at(-1)?.replace(/\.md$/i, '') || 'Wellness item');
    return `<article class="protocol-day-bundle"><div class="protocol-day-bundle-heading"><div><strong>${escapeHtml(bundle.name || 'Protocol bundle')}</strong><span>${escapeHtml(formatClock(bundle.time || '08:00'))} · ${escapeHtml(cycle.name)}</span></div>${complete ? '<span class="protocol-day-complete">Completed</span>' : ''}</div><div class="protocol-day-bundle-items">${names.map(escapeHtml).join(' · ')}</div></article>`;
  }).join('') : '<p class="protocol-day-empty">Nothing is scheduled for this day.</p>';
}

function renderProtocolBundles() {
  $('.protocol-bundle-panel').classList.toggle('hidden', state.protocolBundles.length === 0);
  const select = $('#protocol-bundle-select');
  const previous = state.selectedProtocolBundle;
  select.innerHTML = '<option value="">Choose a bundle…</option>' + state.protocolBundles.map((bundle) => `<option value="${escapeHtml(bundle.id)}">${escapeHtml(bundle.name)}</option>`).join('');
  state.selectedProtocolBundle = state.protocolBundles.some((bundle) => bundle.id === previous) ? previous : '';
  select.value = state.selectedProtocolBundle;
  const bundle = state.protocolBundles.find((entry) => entry.id === state.selectedProtocolBundle);
  $('#protocol-bundle-commit').disabled = !bundle;
  const preview = $('#protocol-bundle-preview');
  preview.classList.toggle('hidden', !bundle);
  const areas = { waking: 'Waking', breakfast: 'Breakfast', afternoon: 'Afternoon', bedtime: 'Bedtime' };
  const targetDay = new Date(`${state.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  preview.innerHTML = bundle ? `<strong>${escapeHtml(bundle.name)}</strong><span>${bundle.items.length} ${bundle.items.length === 1 ? 'item' : 'items'} · ${escapeHtml([...new Set(bundle.items.map((item) => areas[item.timing] || 'Unassigned'))].join(', '))} · ${escapeHtml(targetDay)}</span>` : '';
}

function protocolFrequencyMatchesDate(value, date, cycleStartDate = '') {
  const frequency = normalizeProtocolFrequency(value);
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (frequency === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (frequency === 'weekly' && cycleStartDate) {
    const days = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${cycleStartDate}T12:00:00Z`)) / 86400000;
    return days >= 0 && days % 7 === 0;
  }
  if (!frequency?.startsWith('days:')) return true;
  return PROTOCOL_DAYS.some((day) => day.jsDay === weekday && frequency.slice(5).split(',').includes(day.key));
}

function scheduledProtocolBundles(date) {
  return state.protocolCycles
    .filter((cycle) => date >= cycle.startDate && date <= cycle.endDate)
    .flatMap((cycle) => (cycle.bundles || []).map((bundle) => ({
      cycle,
      bundle,
      items: (bundle.items || []).filter((item) => protocolFrequencyMatchesDate(item.frequency, date, cycle.startDate))
    })).filter((entry) => entry.items.length));
}

function cycleDateLabel(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderProtocolCycles() {
  const select = $('#protocol-cycle-select');
  const previous = state.selectedProtocolCycle;
  select.innerHTML = '<option value="">Choose a cycle…</option>' + state.protocolCycles.map((cycle) => `<option value="${escapeHtml(cycle.id)}">${escapeHtml(cycle.name)}</option>`).join('');
  state.selectedProtocolCycle = state.protocolCycles.some((cycle) => cycle.id === previous) ? previous : (state.protocolCycles[0]?.id || '');
  select.value = state.selectedProtocolCycle;
  const cycle = state.protocolCycles.find((item) => item.id === state.selectedProtocolCycle);
  $('#protocol-cycle-add-bundle').disabled = !cycle;
  $('#protocol-cycle-empty').classList.toggle('hidden', Boolean(cycle));
  $('#protocol-cycle-summary').classList.toggle('hidden', !cycle);
  $('#protocol-cycle-summary').innerHTML = cycle
    ? `<strong>${escapeHtml(cycle.name)}</strong><span>${cycleDateLabel(cycle.startDate)} – ${cycleDateLabel(cycle.endDate)}</span><span class="protocol-cycle-current-day">Selected day: ${escapeHtml(state.date)}${state.date < cycle.startDate || state.date > cycle.endDate ? ' · outside this cycle' : ''}</span><button class="text-button" type="button" data-edit-protocol-cycle="${escapeHtml(cycle.id)}">Edit cycle</button>`
    : '';
  const bundles = cycle?.bundles || [];
  const hasAdditionalProtocolTypes = bundles.some((bundle) => bundle.items.some((item) => !['supplement', 'prescription', 'peptide'].includes(String(item.category || '').toLowerCase())));
  $('#protocol-cycle-bundles').classList.toggle('hidden', !cycle);
  $('#protocol-cycle-bundles').innerHTML = cycle && !bundles.length
    ? '<div class="protocol-cycle-first-bundle"><p>This cycle has no bundles yet. Create one by choosing Wellness items and setting their daily area and frequency.</p><button class="button secondary" type="button" data-create-cycle-bundle>Build first bundle</button></div>'
    : bundles.map((bundle) => {
    const categoryGroups = [
      { categories: ['supplement'], label: 'Supplements' },
      { categories: ['prescription'], label: 'Prescriptions' },
      { categories: ['peptide'], label: 'Peptides' },
      ...(hasAdditionalProtocolTypes ? [{ categories: ['bioregulator', 'other'], label: 'Bioregulators & other' }] : [])
    ];
    const itemGroups = categoryGroups.map((group) => {
      const items = bundle.items.filter((item) => group.categories.includes(String(item.category || '').toLowerCase()) || (group.categories.includes('other') && !['supplement', 'prescription', 'peptide', 'bioregulator'].includes(String(item.category || '').toLowerCase())));
      const itemList = items.map((item) => {
        const name = item.name || item.relativePath?.split('/').at(-1)?.replace(/\.md$/i, '') || 'Wellness item';
        return `<li><strong>${escapeHtml(name)}</strong></li>`;
      }).join('');
      return `<section class="protocol-cycle-item-group"><h4>${group.label}</h4>${items.length ? `<ul class="protocol-cycle-item-list">${itemList}</ul>` : '<p class="protocol-cycle-group-empty">No items</p>'}</section>`;
    }).join('');
    return `<article class="protocol-cycle-bundle ${hasAdditionalProtocolTypes ? 'has-additional-types' : ''}"><div class="protocol-cycle-bundle-copy"><div class="protocol-cycle-bundle-header"><div><h3>${escapeHtml(bundle.name)}</h3><span>${bundle.items.length} ${bundle.items.length === 1 ? 'item' : 'items'} · ${escapeHtml(formatClock(bundle.time || '08:00'))}</span></div><button class="text-button" type="button" data-edit-cycle-bundle="${escapeHtml(bundle.id)}">Edit</button></div><div class="protocol-cycle-item-groups">${itemGroups}</div></div></article>`;
  }).join('');
}

function renderProtocolLibrary() {
  const cycle = state.protocolCycles.find((item) => item.id === state.selectedProtocolCycle);
  $('#protocol-library-month').textContent = cycle ? `${cycle.name} · ${cycleDateLabel(cycle.startDate)} – ${cycleDateLabel(cycle.endDate)}` : 'Create a cycle before adding a bundle.';
  const query = $('#protocol-library-search').value.trim().toLowerCase();
  const category = $('#protocol-library-category').value;
  const selectedCount = [...state.protocolCycleDraft.values()].filter((entry) => entry.selected).length;
  $('#protocol-library-count').textContent = `${selectedCount} selected`;
  const items = state.protocolItems.filter((item) => {
    const matchesQuery = !query || [item.name, item.description, item.itemType, item.category, item.dose].some((value) => String(value || '').toLowerCase().includes(query));
    return matchesQuery && (!category || item.category === category);
  });
  $('#protocol-library-list').innerHTML = items.length ? items.map((item) => {
    const draft = state.protocolCycleDraft.get(item.relativePath) || {};
    const timing = draft.timing || item.timing || 'waking';
    const frequency = draft.frequency || normalizeProtocolFrequency(item.frequency) || 'daily';
    const info = [item.category, item.dose].filter(Boolean).join(' · ');
    return `<article class="protocol-library-row cycle-library-row"><input type="checkbox" data-cycle-item="${escapeHtml(item.relativePath)}" ${draft.selected ? 'checked' : ''} aria-label="Include ${escapeHtml(item.name)} in this bundle"><div class="protocol-library-copy"><div><button class="protocol-note-link" data-open-library="${escapeHtml(item.relativePath)}">${escapeHtml(item.name)} ↗</button></div><span>${escapeHtml(info || item.itemType || 'Wellness item')}</span></div><label class="protocol-frequency-control"><span>Area</span><select data-cycle-timing="${escapeHtml(item.relativePath)}" aria-label="Daily area for ${escapeHtml(item.name)}"><option value="waking" ${timing === 'waking' ? 'selected' : ''}>Waking</option><option value="breakfast" ${timing === 'breakfast' ? 'selected' : ''}>Breakfast</option><option value="afternoon" ${timing === 'afternoon' ? 'selected' : ''}>Afternoon</option><option value="bedtime" ${timing === 'bedtime' ? 'selected' : ''}>Bedtime</option></select></label><label class="protocol-frequency-control"><span>Frequency</span><select data-cycle-frequency="${escapeHtml(item.relativePath)}" aria-label="Frequency for ${escapeHtml(item.name)}"><option value="daily" ${frequency === 'daily' ? 'selected' : ''}>Daily</option><option value="weekdays" ${frequency === 'weekdays' ? 'selected' : ''}>Weekdays</option><option value="weekly" ${frequency === 'weekly' ? 'selected' : ''}>Weekly</option><option value="custom" ${frequency.startsWith('days:') ? 'selected' : ''}>Specific days…</option></select></label>${renderCycleWeekdaySelector(item.relativePath, frequency)}</article>`;
  }).join('') : '<p class="protocol-empty">No Wellness items match this search.</p>';
  $('#protocol-bundle-selection-count').textContent = `${selectedCount} ${selectedCount === 1 ? 'item' : 'items'} selected`;
  $('#protocol-cycle-bundle-save').disabled = false;
}

function syncCycleBundleSelectionsFromEditor() {
  for (const checkbox of $$('#protocol-library-list [data-cycle-item]:checked')) {
    const relativePath = checkbox.dataset.cycleItem;
    const row = checkbox.closest('.cycle-library-row');
    if (!relativePath || !row) continue;
    const item = state.protocolItems.find((entry) => entry.relativePath === relativePath);
    const draft = state.protocolCycleDraft.get(relativePath) || {
      selected: true,
      timing: item?.timing || 'waking',
      frequency: normalizeProtocolFrequency(item?.frequency) || 'daily'
    };
    draft.selected = true;
    draft.timing = row.querySelector('[data-cycle-timing]')?.value || draft.timing;
    const frequency = row.querySelector('[data-cycle-frequency]')?.value || draft.frequency;
    if (frequency === 'custom') {
      const selectedDays = [...row.querySelectorAll('[data-cycle-weekday]:checked')].map((input) => input.value);
      draft.frequency = `days:${PROTOCOL_DAYS.filter((day) => selectedDays.includes(day.key)).map((day) => day.key).join(',')}`;
    } else {
      draft.frequency = frequency;
    }
    state.protocolCycleDraft.set(relativePath, draft);
  }
}

function normalizeProtocolFrequency(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'weekdays' || text === 'weekday') return 'weekdays';
  if (text === 'weekly' || text === 'week') return 'weekly';
  if (text === 'daily' || text === 'every day') return 'daily';
  const days = PROTOCOL_DAYS.filter((day) => day.aliases.some((alias) => new RegExp(`\\b${alias}\\b`).test(text))).map((day) => day.key);
  if (days.length) return `days:${days.join(',')}`;
  return '';
}

function workoutDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfWorkoutWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

function workoutDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderWorkoutWeekCalendar() {
  const weekStart = startOfWorkoutWeek(new Date());
  weekStart.setDate(weekStart.getDate() + state.workoutWeekOffset * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const title = sameMonth
    ? `${weekStart.toLocaleDateString(undefined, { month: 'long' })} ${weekStart.getDate()}–${weekEnd.getDate()}`
    : `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  $('#workout-calendar-title').textContent = state.workoutWeekOffset === 0 ? `This week · ${title}` : title;
  $('#workout-week-today').classList.toggle('hidden', state.workoutWeekOffset === 0);
  const byDay = new Map();
  for (const workout of state.hevyWorkouts) {
    const date = workoutDate(workout.startTime);
    if (!date) continue;
    const key = workoutDayKey(date);
    const entries = byDay.get(key) || [];
    entries.push(workout);
    byDay.set(key, entries);
  }
  const todayKey = workoutDayKey(new Date());
  const workoutPlans = state.config?.workoutPlans || {};
  const suggestions = [...new Set(state.hevyWorkouts.map((workout) => String(workout.title || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#workout-routine-suggestions').innerHTML = suggestions.map((name) => `<option value="${escapeHtml(name)}"></option>`).join('');
  $('#workout-week-calendar').innerHTML = Array.from({ length: 7 }, (_value, index) => {
    const date = new Date(weekStart);
    date.setDate(date.getDate() + index);
    const key = workoutDayKey(date);
    const entries = byDay.get(key) || [];
    const planned = workoutPlans[key] || '';
    return `<article class="workout-calendar-day${key === todayKey ? ' is-today' : ''}${entries.length ? ' has-workout' : ''}${planned ? ' has-plan' : ''}"><div class="workout-calendar-day-heading"><span>${date.toLocaleDateString(undefined, { weekday: 'short' })}</span><strong>${date.getDate()}</strong></div>${planned ? `<button class="workout-planned-routine" type="button" data-plan-workout-date="${key}" title="Edit planned routine"><span>Planned</span><strong>${escapeHtml(planned)}</strong></button>` : `<button class="workout-calendar-empty workout-plan-add" type="button" data-plan-workout-date="${key}">+ Plan routine</button>`}${entries.length ? `<ul>${entries.map((workout) => `<li title="${escapeHtml(workout.title)}">${escapeHtml(workout.title)}</li>`).join('')}</ul>` : ''}</article>`;
  }).join('');
}

function openWorkoutPlan(date) {
  state.workoutPlanDate = date;
  const existing = state.config?.workoutPlans?.[date] || '';
  $('#workout-plan-title').textContent = existing ? 'Edit planned routine' : 'Plan a routine';
  $('#workout-plan-date').textContent = prettyDate(date, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#workout-plan-name').value = existing;
  $('#workout-plan-clear').classList.toggle('hidden', !existing);
  $('#workout-plan-modal').classList.remove('hidden');
  $('#workout-plan-name').focus();
}

async function saveWorkoutPlan(date, routine) {
  const plans = { ...(state.config?.workoutPlans || {}) };
  if (routine) plans[date] = routine.trim();
  else delete plans[date];
  state.config = await window.daybook.saveConfig({ workoutPlans: plans });
  renderWorkoutWeekCalendar();
}

function formatWorkoutDuration(minutes) {
  const value = Math.max(0, Math.round(minutes || 0));
  if (value >= 60) return `${Math.floor(value / 60)}h ${value % 60}m`;
  return `${value}m`;
}

function workoutWorkingSets(workout) {
  return (workout.exercises || []).flatMap((exercise) => exercise.sets || [])
    .filter((set) => !String(set.type || '').toLowerCase().includes('warm'));
}

function renderWorkoutDashboard() {
  const dashboard = $('#workout-dashboard');
  const empty = $('#hevy-workout-empty');
  const hasData = state.hevyWorkouts.length > 0;
  dashboard.classList.remove('hidden');
  empty.classList.toggle('hidden', hasData);
  renderWorkoutWeekCalendar();
  if (state.hevyLoading) {
    empty.querySelector('h2').textContent = 'Loading workout history…';
    empty.querySelector('p').textContent = 'Gathering your sessions and exercise details from Hevy.';
    return;
  }
  if (!state.hevyConnected) {
    empty.querySelector('h2').textContent = 'Connect Hevy to see your training';
    empty.querySelector('p').textContent = state.hevyError || 'Add your Hevy API key in Settings to load workout history, exercise sets, and progress stats.';
    return;
  }
  if (!state.hevyWorkouts.length) {
    empty.querySelector('h2').textContent = state.hevyError || 'No workouts found yet';
    empty.querySelector('p').textContent = state.hevyError ? 'Check your connection or Hevy API key in Settings, then refresh.' : 'Once you log a workout in Hevy, your training history will appear here.';
    return;
  }

  const sorted = [...state.hevyWorkouts].sort((a, b) => (workoutDate(b.startTime)?.getTime() || 0) - (workoutDate(a.startTime)?.getTime() || 0));
  const periodValue = $('#workout-period').value;
  const now = new Date();
  const weeks = periodValue === 'all' ? null : Number(periodValue);
  const cutoff = weeks ? startOfWorkoutWeek(now) : null;
  if (cutoff && weeks) cutoff.setDate(cutoff.getDate() - (weeks - 1) * 7);
  const workouts = sorted.filter((workout) => {
    const date = workoutDate(workout.startTime);
    return !cutoff || !date || date >= cutoff;
  });
  $('#workout-period-title').textContent = periodValue === 'all' ? 'All history' : `Last ${periodValue} weeks`;
  const syncedDate = workoutDate(state.hevyCachedAt);
  const syncedLabel = syncedDate ? syncedDate.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const cacheLabel = state.hevyFromCache ? 'Saved copy' : 'Synced';
  $('#workout-history-count').textContent = `${state.hevyWorkouts.length} sessions · ${cacheLabel}${syncedLabel ? ` ${syncedLabel}` : ''}${state.hevyError ? ` · ${state.hevyError}` : ''}`;
  $('#workout-stat-count').textContent = String(workouts.length);
  $('#workout-stat-count-note').textContent = periodValue === 'all' ? 'in all history' : `in the last ${periodValue} weeks`;
  const totalMinutes = workouts.reduce((sum, workout) => sum + (Number(workout.durationMinutes) || 0), 0);
  $('#workout-stat-time').textContent = formatWorkoutDuration(totalMinutes);
  $('#workout-stat-average').textContent = formatWorkoutDuration(workouts.length ? totalMinutes / workouts.length : 0);
  const sets = workouts.flatMap(workoutWorkingSets);
  const volumeKgReps = sets.reduce((sum, set) => sum + (Number(set.weightKg) || 0) * (Number(set.reps) || 0), 0);
  $('#workout-stat-sets').textContent = String(sets.length);
  $('#workout-stat-volume').textContent = volumeKgReps ? `${Math.round(volumeKgReps).toLocaleString()} kg × reps logged` : 'Warm-up sets excluded';

  const chartWeeks = weeks || 26;
  const chartStart = cutoff || startOfWorkoutWeek(now);
  if (!weeks) chartStart.setDate(chartStart.getDate() - (chartWeeks - 1) * 7);
  $('#workout-chart-subtitle').textContent = periodValue === 'all' ? 'Each week · last 26 weeks' : 'Workouts completed each week';
  const buckets = Array.from({ length: chartWeeks }, (_value, index) => {
    const date = new Date(chartStart);
    date.setDate(date.getDate() + index * 7);
    return { date, count: 0 };
  });
  for (const workout of workouts) {
    const date = workoutDate(workout.startTime);
    if (!date) continue;
    const index = Math.floor((startOfWorkoutWeek(date) - chartStart) / (7 * 24 * 60 * 60 * 1000));
    if (index >= 0 && index < buckets.length) buckets[index].count += 1;
  }
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));
  $('#workout-week-chart').innerHTML = buckets.map((bucket) => {
    const height = bucket.count ? Math.max(8, Math.round((bucket.count / maxCount) * 100)) : 3;
    const label = bucket.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="workout-week-column" title="Week of ${escapeHtml(label)}: ${bucket.count} workouts"><span class="workout-week-count">${bucket.count || ''}</span><div class="workout-week-track"><i style="height:${height}%" class="${bucket.count ? '' : 'is-empty'}"></i></div><span class="workout-week-label">${escapeHtml(label)}</span></div>`;
  }).join('');

  const exerciseStats = new Map();
  for (const workout of workouts) {
    for (const exercise of workout.exercises || []) {
      const name = String(exercise.name || 'Exercise');
      const stat = exerciseStats.get(name) || { name, sets: 0, volume: 0 };
      for (const set of exercise.sets || []) {
        if (String(set.type || '').toLowerCase().includes('warm')) continue;
        stat.sets += 1;
        stat.volume += (Number(set.weightKg) || 0) * (Number(set.reps) || 0);
      }
      exerciseStats.set(name, stat);
    }
  }
  const topExercises = [...exerciseStats.values()].sort((a, b) => b.sets - a.sets || b.volume - a.volume).slice(0, 6);
  $('#workout-exercise-empty').classList.toggle('hidden', topExercises.length > 0);
  $('#workout-exercise-list').innerHTML = topExercises.map((exercise) => {
    const percent = Math.max(5, Math.round((exercise.sets / Math.max(1, topExercises[0].sets)) * 100));
    return `<div class="workout-exercise-row"><div class="workout-exercise-title"><strong>${escapeHtml(exercise.name)}</strong><span>${exercise.sets} sets</span></div><div class="workout-exercise-bar"><i style="width:${percent}%"></i></div></div>`;
  }).join('');

  $('#workout-list-count').textContent = `${workouts.length} sessions`;
  $('#workout-history-list').innerHTML = workouts.length ? workouts.map((workout) => {
    const date = workoutDate(workout.startTime);
    const dateLabel = date ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'Date unavailable';
    const detail = `${formatWorkoutDuration(workout.durationMinutes)} · ${workout.exerciseCount || (workout.exercises || []).length} exercises · ${workoutWorkingSets(workout).length} sets`;
    const exerciseLines = (workout.exercises || []).map((exercise) => {
      const workingSets = (exercise.sets || []).filter((set) => !String(set.type || '').toLowerCase().includes('warm'));
      const summary = workingSets.map((set) => [set.weightKg ? `${set.weightKg} kg` : '', set.reps ? `${set.reps} reps` : '', set.distanceMeters ? `${set.distanceMeters} m` : '', set.durationSeconds ? `${set.durationSeconds}s` : ''].filter(Boolean).join(' × ')).filter(Boolean).join(', ');
      return `<li><strong>${escapeHtml(exercise.name)}</strong>${summary ? `<span>${escapeHtml(summary)}</span>` : `<span>${workingSets.length} sets</span>`}</li>`;
    }).join('');
    return `<details class="workout-history-row"><summary><span class="workout-history-mark">↗</span><span class="workout-history-title"><strong>${escapeHtml(workout.title)}</strong><span>${escapeHtml(dateLabel)} · ${escapeHtml(detail)}</span></span><span class="work-source-chevron" aria-hidden="true">⌄</span></summary>${exerciseLines ? `<ul class="workout-detail-list">${exerciseLines}</ul>` : '<p class="workout-subtle workout-no-details">Exercise details were not included for this session.</p>'}</details>`;
  }).join('') : '<p class="workout-subtle">No sessions in this period.</p>';
}

function setActiveView(view) {
  const modules = state.config?.modules || {};
  if ((view === 'habits' && modules.habits === false && modules.wellness === false) || (view === 'workouts' && modules.hevy === false)) view = 'today';
  state.activeView = view;
  applyModuleVisibility();
  const labels = { today: 'TODAY', journal: 'JOURNAL', meetings: 'MEETINGS', people: 'PEOPLE', projects: 'PROJECTS', work: 'TASKS', habits: state.config?.modules?.wellness === false ? 'HABITS' : 'PROTOCOLS', workouts: 'WORKOUTS' };
  $('#workspace-crumb').textContent = labels[view] || 'DAYBOOK';
  $('#setup-view').classList.toggle('hidden', Boolean(state.config.vaultPath) || view !== 'today');
  $('#today-view').classList.toggle('hidden', !state.config.vaultPath || view !== 'today');
  $('#journal-view').classList.toggle('hidden', view !== 'journal');
  $('#meetings-view').classList.toggle('hidden', view !== 'meetings');
  $('#people-view').classList.toggle('hidden', view !== 'people');
  $('#projects-view').classList.toggle('hidden', view !== 'projects');
  $('#work-view').classList.toggle('hidden', view !== 'work');
  $('#habits-view').classList.toggle('hidden', view !== 'habits');
  $('#workouts-view').classList.toggle('hidden', view !== 'workouts');
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  $('#open-note').title = view === 'journal' ? 'Open this journal day in Obsidian' : 'Open today’s note in Obsidian';
  $('#open-note').setAttribute('aria-label', $('#open-note').title);
  if (view === 'work') loadWork();
  if (view === 'meetings') loadMeetingNotes();
  if (view === 'people') loadPeople();
  if (view === 'projects') loadProjects();
  if (view === 'habits' && (modules.habits !== false || modules.wellness !== false)) refreshHabits().catch((error) => showToast(error.message, true));
  if (view === 'workouts') {
    if (!state.hevyLoaded && modules.hevy !== false) {
      state.hevyLoading = true;
      renderWorkoutDashboard();
      loadCachedHevyWorkouts().then(() => {
        if (state.config.hevyApiKey) return refreshHevyWorkouts();
        state.hevyLoaded = true;
        state.hevyLoading = false;
        renderWorkoutDashboard();
      });
    } else renderWorkoutDashboard();
  }
}

async function loadPeople() {
  try {
    state.people = await window.daybook.listPeople();
    renderPeople();
  } catch (error) { showToast(error.message, true); }
}

function renderPeople() {
  const people = state.people || [];
  $('#people-count').textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
  $('#nav-people-count').textContent = String(people.length);
  $('#people-empty').classList.toggle('hidden', people.length > 0);
  $('#people-list').classList.toggle('hidden', people.length === 0);
  $('#people-list').innerHTML = people.map((person) => `<button class="person-row" type="button" data-open-person="${escapeHtml(person.relativePath)}"><span class="person-avatar">${escapeHtml(person.title.slice(0, 1).toUpperCase())}</span><span class="person-row-copy"><strong>${escapeHtml(person.title)}</strong><small>${escapeHtml([person.role, person.organization].filter(Boolean).join(' · ') || 'Person note')}</small></span><span class="person-row-arrow">›</span></button>`).join('');
}

async function openPersonDetail(relativePath) {
  const person = (state.people || []).find((item) => item.relativePath === relativePath);
  if (!person) return;
  state.selectedPerson = person;
  if (!state.obsidianTasks.length && !state.reminders.length && !Object.values(state.tasksByQuadrant).flat().length) await loadWork();
  const [meetings, projects] = await Promise.all([window.daybook.listMeetingNotes().catch(() => []), window.daybook.listProjects().catch(() => [])]);
  state.meetingNotes = meetings;
  state.projects = projects;
  const pathKey = relativePath.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
  const nameKey = person.title.toLowerCase();
  const isLinked = (value) => String(value || '').replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').toLowerCase() === pathKey || String(value || '').replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').toLowerCase() === nameKey;
  const associatedMeetings = meetings.filter((item) => (item.people || []).some(isLinked));
  const associatedProjects = projects.filter((item) => (item.people || []).some(isLinked));
  const associatedTasks = projectTaskCandidates().filter((task) => {
    if ((person.taskLinks || []).includes(taskPersonKey(task.source, task))) return true;
    if (task.source === 'obsidian' && (task.people || []).some(isLinked)) return true;
    return associatedProjects.some((project) => (project.taskLinks || []).some((link) => projectTaskKey(link) === projectTaskKey(task)));
  });
  $('#people-directory').classList.add('hidden');
  $('#person-detail').classList.remove('hidden');
  $('#person-detail-name').textContent = person.title;
  $('#person-detail-avatar').textContent = person.title.slice(0, 1).toUpperCase();
  $('#person-detail-meta').textContent = [person.role, person.organization].filter(Boolean).join(' · ') || 'Person note';
  state.personAssociations = {
    meetings: associatedMeetings.map((item) => ({ category: 'Meeting', title: item.title, detail: [item.meetingType, item.date].filter(Boolean).join(' · '), path: item.relativePath })),
    projects: associatedProjects.map((item) => ({ category: 'Project', title: item.title, detail: item.status || 'Project', path: item.relativePath })),
    tasks: associatedTasks.map((task) => {
      const taskProjects = projects.filter((project) => (project.taskLinks || []).some((link) => projectTaskKey(link) === projectTaskKey(task))).map((project) => project.title);
      const important = Number(task.priority || 1) >= 3;
      const urgent = taskUrgency(task.dueDate);
      const quadrant = important ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'later');
      return { category: task.source === 'reminder' ? 'Apple Reminder' : task.source === 'todoist' ? 'Todoist' : 'Obsidian task', title: task.title, detail: [taskProjects.join(', ') || 'No project', task.dueDate ? `Due ${String(task.dueDate).slice(0, 10)}` : '', important ? 'Important' : 'Normal priority'].filter(Boolean).join(' · '), path: task.source === 'obsidian' ? task.relativePath : '', line: task.line, text: task.text, source: task.source, id: task.id, projectNames: taskProjects.length ? taskProjects : ['No project'], quadrant, dueDate: task.dueDate || '', priority: task.priority || 1 };
    })
  };
  state.personAssociationFilter = 'all';
  state.personTaskUrgencyFilter = 'all';
  state.personTaskSourceFilter = 'all';
  $('#person-association-search').value = '';
  renderPersonAssociations();
}

function renderPersonAssociations() {
  const lists = state.personAssociations || { meetings: [], tasks: [], projects: [] };
  const counts = { meetings: lists.meetings.length, tasks: lists.tasks.length, projects: lists.projects.length };
  const total = counts.meetings + counts.tasks + counts.projects;
  const focusBaseTasks = lists.tasks.filter((task) => state.personTaskSourceFilter === 'all' || task.source === state.personTaskSourceFilter);
  const urgencyCounts = { do: 0, schedule: 0, delegate: 0, later: 0 };
  for (const task of focusBaseTasks) urgencyCounts[task.quadrant] = (urgencyCounts[task.quadrant] || 0) + 1;
  $('#person-task-urgency-all-count').textContent = String(focusBaseTasks.length);
  for (const [quadrant, count] of Object.entries(urgencyCounts)) $(`[data-person-task-urgency-count="${quadrant}"]`).textContent = String(count);
  $('#person-count-all').textContent = String(total);
  $('#person-meeting-count').textContent = String(counts.meetings);
  $('#person-task-count').textContent = String(counts.tasks);
  $('#person-project-count').textContent = String(counts.projects);
  const filter = state.personAssociationFilter || 'all';
  $('#person-task-filters').classList.toggle('hidden', filter !== 'tasks');
  const sourceCounts = { all: lists.tasks.length, todoist: 0, obsidian: 0, reminder: 0 };
  for (const task of lists.tasks) sourceCounts[task.source] = (sourceCounts[task.source] || 0) + 1;
  for (const [source, count] of Object.entries(sourceCounts)) $(`[data-person-task-source-count="${source}"]`).textContent = String(count);
  $$('#person-task-source-tabs [data-person-task-source]').forEach((button) => {
    const selected = button.dataset.personTaskSource === state.personTaskSourceFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $$('#person-task-urgency-tabs [data-person-task-urgency]').forEach((button) => {
    const selected = button.dataset.personTaskUrgency === state.personTaskUrgencyFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  const query = ($('#person-association-search').value || '').trim().toLowerCase();
  const categoryOrder = ['meetings', 'tasks', 'projects'];
  const categories = filter === 'all' ? categoryOrder : [filter];
  const titleMap = { all: 'All linked work', meetings: 'Meetings', tasks: 'Tasks', projects: 'Projects' };
  const subtitleMap = { all: 'Meetings, tasks, and projects connected to this person.', meetings: 'Meetings connected to this person.', tasks: 'Tasks assigned to this person or linked through their projects.', projects: 'Projects connected to this person.' };
  $('#person-association-title').textContent = titleMap[filter] || titleMap.all;
  $('#person-association-subtitle').textContent = subtitleMap[filter] || subtitleMap.all;
  $$('#person-association-tabs [data-person-filter]').forEach((button) => {
    const selected = button.dataset.personFilter === filter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  let rows = categories.flatMap((category) => lists[category] || []);
  if (filter === 'tasks' && state.personTaskSourceFilter !== 'all') rows = rows.filter((item) => item.source === state.personTaskSourceFilter);
  if (filter === 'tasks' && state.personTaskUrgencyFilter !== 'all') rows = rows.filter((item) => item.quadrant === state.personTaskUrgencyFilter);
  rows = rows.filter((item) => !query || `${item.title} ${item.detail} ${item.category}`.toLowerCase().includes(query));
  $('#person-association-visible-count').textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'items'}`;
  if (filter === 'tasks') {
    const projectGroups = new Map();
    for (const item of rows) {
      const projectName = item.projectNames?.find((name) => name !== 'No project') || 'No project';
      if (!projectGroups.has(projectName)) projectGroups.set(projectName, []);
      projectGroups.get(projectName).push(item);
    }
    $('#person-associations').classList.add('person-task-list-mode');
    $('#person-associations').innerHTML = rows.length ? [...projectGroups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' })).map(([projectName, tasks]) => `<details class="aggregate-project-group person-project-group" open><summary><h3>${escapeHtml(projectName)}</h3><span>${tasks.length}</span></summary>${tasks.map((item) => {
      const sourceLabel = item.source === 'reminder' ? 'Apple Reminders' : item.source === 'todoist' ? 'Todoist' : 'Obsidian';
      const sourceClass = item.source === 'reminder' ? 'reminders' : item.source;
      const dueText = item.dueDate ? cycleDateLabel(item.dueDate) : 'No due date';
      const priorityLabel = ({ 1: 'Normal', 2: 'Medium', 3: 'High', 4: 'Urgent' })[item.priority] || 'Normal';
      const openAttrs = item.source === 'obsidian' ? `data-person-open-task="obsidian" data-person-task-file="${escapeHtml(item.path)}" data-person-task-line="${item.line || ''}" data-person-task-text="${escapeHtml(item.text || '')}"` : `data-person-open-task="${item.source}" data-person-task-id="${escapeHtml(item.id)}"`;
      return `<article class="aggregate-task-row"><span class="task-readonly-mark" aria-hidden="true">•</span><div class="aggregate-task-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div><span class="task-origin-tag ${sourceClass}">${sourceLabel}</span><span class="aggregate-task-date ${item.dueDate ? '' : 'no-date'}">${escapeHtml(dueText)}</span><span class="aggregate-task-priority priority-${item.priority}">${priorityLabel}</span><button class="task-open-link" type="button" ${openAttrs} aria-label="Open ${escapeHtml(item.title)} in ${sourceLabel}" title="Open in ${sourceLabel}">↗</button></article>`;
    }).join('')}</details>`).join('') : `<div class="aggregate-task-empty">${query ? 'No linked tasks match your search.' : 'No tasks match this focus group.'}</div>`;
    return;
  }
  $('#person-associations').classList.remove('person-task-list-mode');
  $('#person-associations').innerHTML = rows.length ? rows.map((item) => {
    const open = item.category === 'Meeting'
      ? `data-person-open-meeting="${escapeHtml(item.path)}"`
      : item.path ? `data-person-open-note="${escapeHtml(item.path)}"` : `data-person-open-task="${escapeHtml(item.source)}" data-person-task-id="${escapeHtml(item.id)}"`;
    const typeClass = item.category.toLowerCase().replace(/\s+/g, '-');
    return `<button class="person-association-row" type="button" ${open}><span class="person-association-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail || item.category)}</small></span><span class="person-association-kind ${typeClass}">${escapeHtml(item.category)}</span><i>↗</i></button>`;
  }).join('') : `<p class="person-association-empty">${query ? 'No linked items match your search.' : `No linked ${filter === 'all' ? 'meetings, tasks, or projects' : filter} yet.`}</p>`;
}

function renderProjectPeopleChoices(selected = []) {
  const chosen = new Set(selected);
  $('#project-people-choices').innerHTML = state.people?.length ? state.people.map((person) => `<label class="meeting-person-choice"><input type="checkbox" value="${escapeHtml(person.relativePath)}" ${chosen.has(person.relativePath) ? 'checked' : ''}><span>${escapeHtml(person.title)}</span></label>`).join('') : '<span class="meeting-people-empty">No people in your People folder yet.</span>';
}

function renderMeetingPeopleChoices(selected = []) {
  const chosen = new Set(selected);
  const target = $('#create-meeting-people');
  if (!state.people?.length) {
    target.innerHTML = '<span class="meeting-people-empty">No people yet. Add a person to create a note in your People folder.</span>';
    return;
  }
  target.innerHTML = state.people.map((person) => `<label class="meeting-person-choice"><input type="checkbox" value="${escapeHtml(person.relativePath)}" ${chosen.has(person.relativePath) ? 'checked' : ''}><span>${escapeHtml(person.title)}</span></label>`).join('');
}

function openPersonModal() {
  $('#person-form').reset();
  $('#person-status').textContent = '';
  $('#person-modal').classList.remove('hidden');
  $('#person-name').focus();
}

function applyModuleVisibility() {
  const modules = state.config?.modules || {};
  const habitsEnabled = modules.habits !== false;
  const wellnessEnabled = modules.wellness !== false;
  const todoistEnabled = modules.todoist !== false;
  const hevyEnabled = modules.hevy !== false;
  const habitsNav = $('.nav-item[data-view="habits"]');
  const workoutsNav = $('.nav-item[data-view="workouts"]');
  if (habitsNav) {
    habitsNav.classList.toggle('hidden', !habitsEnabled && !wellnessEnabled);
    habitsNav.querySelector('span:nth-child(2)').textContent = wellnessEnabled ? 'Protocols' : 'Habits';
  }
  if (workoutsNav) workoutsNav.classList.toggle('hidden', !hevyEnabled);
  $('#wellness-module-content').classList.toggle('hidden', !wellnessEnabled);
  $('#build-protocol').classList.toggle('hidden', !wellnessEnabled);
  $('#protocol-page-title').textContent = wellnessEnabled ? 'Protocols' : 'Habits';
  $('#protocol-page-eyebrow').textContent = wellnessEnabled ? 'WELLNESS' : 'HABIT TRACKING';
  $('#protocol-page-subtitle').textContent = wellnessEnabled
    ? 'See how consistently you complete your scheduled protocol.'
    : 'Track the habits you keep in your Obsidian vault.';
  $('#todoist-module').classList.toggle('hidden', !todoistEnabled);
  $('#connect-todoist').classList.toggle('hidden', !todoistEnabled);
  if (!habitsEnabled && !wellnessEnabled && state.activeView === 'habits') setActiveView('today');
  if (!hevyEnabled && state.activeView === 'workouts') setActiveView('today');
}

function renderMeetingNotes() {
  const notes = state.meetingNotes;
  const editing = Boolean(state.activeMeetingNote);
  $('#meetings-browser').classList.toggle('hidden', editing);
  $('#meeting-editor').classList.toggle('hidden', !editing);
  $('#nav-meetings-count').textContent = String(notes.length);
  renderMeetingCalendar();
  refreshMeetingCalendarEvents();
  const dateNotes = state.selectedMeetingDate
    ? notes.filter((note) => note.date === state.selectedMeetingDate)
    : notes;
  const visibleNotes = dateNotes.filter((note) => !state.showStarredMeetingsOnly || note.starred)
    .sort((a, b) => Number(Boolean(b.starred)) - Number(Boolean(a.starred)) || Date.parse(b.date || b.updatedAt) - Date.parse(a.date || a.updatedAt));
  const starredCount = notes.filter((note) => note.starred).length;
  const starredFilter = $('#meetings-starred-filter');
  starredFilter.classList.toggle('active', state.showStarredMeetingsOnly);
  starredFilter.setAttribute('aria-pressed', String(state.showStarredMeetingsOnly));
  starredFilter.innerHTML = `☆ Starred <span>${starredCount}</span>`;
  $('#meetings-count').textContent = `${visibleNotes.length} ${visibleNotes.length === 1 ? 'note' : 'notes'}`;
  $('#meetings-list').classList.toggle('hidden', visibleNotes.length === 0);
  $('#meetings-empty').classList.toggle('hidden', visibleNotes.length > 0);
  $('#meetings-subtitle').textContent = state.config?.vaultPath
    ? (state.showStarredMeetingsOnly
      ? (state.selectedMeetingDate ? `Starred notes for ${prettyDate(state.selectedMeetingDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.` : 'Your starred meeting notes, ready to open.')
      : (state.selectedMeetingDate ? `Meetings on ${prettyDate(state.selectedMeetingDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}.` : 'Created from events in Today’s calendar.'))
    : 'Choose an Obsidian vault in Settings to see meeting notes.';
  $('#meetings-empty h2').textContent = !state.config?.vaultPath
    ? 'Connect your Obsidian vault'
    : state.showStarredMeetingsOnly ? 'No starred meeting notes here'
    : state.selectedMeetingDate ? 'No meetings on this day' : 'No meeting notes yet';
  $('#meetings-empty p').textContent = !state.config?.vaultPath
    ? 'Choose your vault in Settings. Daybook will read and create meeting notes in its Meetings folder.'
    : state.showStarredMeetingsOnly ? 'Star a meeting note to keep it easy to find here.'
    : state.selectedMeetingDate ? 'Choose another date or show all notes.' : 'Create a note from any event in Today’s calendar. Daybook stores it in your Obsidian vault’s Meetings folder.';
  $('#meetings-go-today').classList.toggle('hidden', !state.config?.vaultPath);
  $('#meetings-list').innerHTML = visibleNotes.map((note) => {
    const dateLabel = note.date ? prettyDate(note.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Meeting note';
    return `<article class="meeting-note-row"><button class="meeting-note-open" type="button" data-open-meeting="${escapeHtml(note.relativePath)}"><span class="meeting-note-icon">▣</span><span class="meeting-note-copy"><strong>${escapeHtml(note.title)}</strong><small>${escapeHtml(note.meetingType || 'Other Meeting')} · ${escapeHtml(dateLabel)} · Obsidian</small></span><span class="meeting-note-arrow">↗</span></button><button class="meeting-note-star ${note.starred ? 'starred' : ''}" type="button" data-star-meeting="${escapeHtml(note.relativePath)}" aria-pressed="${Boolean(note.starred)}" aria-label="${note.starred ? 'Remove from starred meetings' : 'Star meeting note'}" title="${note.starred ? 'Unstar meeting' : 'Star meeting'}">${note.starred ? '★' : '☆'}</button></article>`;
  }).join('');
}

function renderMeetingCalendar() {
  const month = state.meetingMonth;
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const counts = new Map();
  for (const note of state.meetingNotes) {
    if (note.date) counts.set(note.date, (counts.get(note.date) || 0) + 1);
  }
  const eventCounts = new Map();
  for (const event of state.meetingCalendarEvents) {
    const date = event.start ? localDateString(new Date(event.start)) : '';
    if (date) eventCounts.set(date, (eventCounts.get(date) || 0) + 1);
  }
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#meeting-month-label').textContent = monthLabel;
  $('#meeting-date-selection').textContent = state.selectedMeetingDate
    ? `Showing ${prettyDate(state.selectedMeetingDate, { month: 'short', day: 'numeric' })}`
    : 'Select a day to filter meeting notes';
  const weekdayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .map((day) => `<span class="meeting-weekday">${day}</span>`).join('');
  const dayCells = Array.from({ length: firstWeekday + daysInMonth }, (_value, index) => {
    if (index < firstWeekday) return '<span class="meeting-calendar-blank" aria-hidden="true"></span>';
    const day = index - firstWeekday + 1;
    const date = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const count = counts.get(date) || 0;
    const eventCount = eventCounts.get(date) || 0;
    const heat = count ? Math.min(3, count) : 0;
    const selected = state.selectedMeetingDate === date;
    const title = `${eventCount} calendar event${eventCount === 1 ? '' : 's'} · ${count} note${count === 1 ? '' : 's'} on ${prettyDate(date, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    return `<button class="meeting-calendar-day heat-${heat} ${selected ? 'selected' : ''} ${count ? 'has-meeting-notes' : ''} ${eventCount ? 'has-calendar-events' : ''}" type="button" data-meeting-date="${date}" aria-pressed="${selected}" title="${escapeHtml(title)}"><span>${day}</span><span class="meeting-day-markers" aria-hidden="true">${eventCount ? `<i class="calendar-event-marker">${eventCount}</i>` : ''}${count ? `<i class="meeting-note-marker">${count}</i>` : ''}</span></button>`;
  }).join('');
  $('#meeting-calendar-grid').innerHTML = `${weekdayHeaders}${dayCells}`;
  $('#meeting-clear-date').classList.toggle('hidden', !state.selectedMeetingDate);
}

async function refreshMeetingCalendarEvents(month = state.meetingMonth, force = false) {
  const requestedMonth = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  if (!force && (state.meetingCalendarEventsMonth === requestedMonth || state.meetingCalendarEventsRequestedMonth === requestedMonth)) return;
  state.meetingCalendarEventsRequestedMonth = requestedMonth;
  if (state.meetingCalendarEventsMonth !== requestedMonth) state.meetingCalendarEvents = [];
  try {
    const result = await window.daybook.listCalendarMonth(requestedMonth);
    const currentMonth = `${state.meetingMonth.getFullYear()}-${String(state.meetingMonth.getMonth() + 1).padStart(2, '0')}`;
    if (currentMonth !== requestedMonth) return;
    state.meetingCalendarEvents = result.events || [];
    state.meetingCalendarEventsMonth = requestedMonth;
    renderMeetingCalendar();
  } catch (error) {
    console.error('Meeting calendar events:', error);
    state.meetingCalendarEventsMonth = requestedMonth;
    state.meetingCalendarEvents = [];
    renderMeetingCalendar();
  } finally {
    if (state.meetingCalendarEventsRequestedMonth === requestedMonth) state.meetingCalendarEventsRequestedMonth = '';
  }
}

async function loadMeetingNotes() {
  if (!state.config?.vaultPath) {
    state.meetingNotes = [];
    renderMeetingNotes();
    return;
  }
  try {
    state.meetingNotes = await window.daybook.listMeetingNotes();
    renderMeetingNotes();
  } catch (error) {
    state.meetingNotes = [];
    renderMeetingNotes();
    showToast(`Meetings: ${error.message}`, true);
  }
}

function renderProjects() {
  const projects = state.projects;
  const counts = {
    active: projects.filter((project) => project.status === 'active').length,
    paused: projects.filter((project) => project.status === 'paused').length,
    completed: projects.filter((project) => project.status === 'completed').length,
    all: projects.length
  };
  for (const [status, count] of Object.entries(counts)) $(`#project-count-${status}`).textContent = String(count);
  $('#nav-projects-count').textContent = String(counts.active);
  const query = $('#projects-search').value.trim().toLowerCase();
  const visible = projects.filter((project) => (state.activeProjectFilter === 'all' || project.status === state.activeProjectFilter)
    && (!query || [project.title, project.overview, ...project.milestones.map((item) => item.text), ...(project.taskLinks || []).map((item) => item.title), ...projectPeopleNames(project.people)].join(' ').toLowerCase().includes(query)));
  $$('#project-status-tabs [data-project-filter]').forEach((button) => {
    const selected = button.dataset.projectFilter === state.activeProjectFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $('#projects-empty').classList.toggle('hidden', visible.length > 0);
  if (!projects.length) {
    $('#projects-empty h3').textContent = 'No projects yet';
    $('#projects-empty p').textContent = 'Create a project to capture its outcome, tasks, and milestones.';
  } else if (!visible.length) {
    $('#projects-empty h3').textContent = query ? 'No matching projects' : 'Nothing in this view';
    $('#projects-empty p').textContent = query ? 'Try another search.' : 'Choose another status filter to see more projects.';
  }
  const candidateMap = new Map(projectTaskCandidates().map((task) => [projectTaskKey(task), task]));
  $('#projects-list').innerHTML = visible.map((project) => {
    const completed = project.milestones.filter((item) => item.done).length;
    const total = project.milestones.length;
    const progress = total ? Math.round(completed / total * 100) : 0;
    const due = project.dueDate ? prettyDate(project.dueDate, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No target date';
    const overdue = project.dueDate && project.dueDate < state.date && project.status === 'active';
    const statusLabel = project.status.charAt(0).toUpperCase() + project.status.slice(1);
    const linkedTaskCount = project.taskLinks?.length || 0;
    const previewTasks = (project.taskLinks || []).map((link) => candidateMap.get(projectTaskKey(link))).filter(Boolean).sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31')).slice(0, 2);
    const taskPreview = previewTasks.length
      ? `<span class="project-task-preview">${previewTasks.map((task) => `<span><i class="task-origin-tag ${task.source === 'reminder' ? 'reminders' : task.source}">${task.source === 'reminder' ? 'Apple' : task.source === 'todoist' ? 'Todoist' : 'Obsidian'}</i><b>${escapeHtml(task.title)}</b>${task.dueDate ? `<small>${escapeHtml(prettyDate(String(task.dueDate).slice(0, 10), { month: 'short', day: 'numeric' }))}</small>` : ''}</span>`).join('')}${linkedTaskCount > previewTasks.length ? `<small class="project-task-more">+${linkedTaskCount - previewTasks.length} more</small>` : ''}</span>`
      : `<span class="project-task-preview empty">${linkedTaskCount ? `${linkedTaskCount} project task${linkedTaskCount === 1 ? '' : 's'} · refresh Tasks to view` : 'No tasks assigned'}</span>`;
    const peopleNames = projectPeopleNames(project.people);
    const peoplePreview = peopleNames.length ? `<span class="project-card-people">♙ ${escapeHtml(peopleNames.join(', '))}</span>` : '';
    return `<article class="project-card"><button class="project-card-main" type="button" data-open-project-detail="${escapeHtml(project.relativePath)}"><span class="project-card-top"><span class="project-status-pill ${escapeHtml(project.status)}">${escapeHtml(statusLabel)}</span><span class="project-priority ${escapeHtml(project.priority)}">${escapeHtml(project.priority)} priority</span></span><strong class="project-card-title">${escapeHtml(project.title)}</strong><span class="project-card-overview">${escapeHtml(project.overview || 'Add an overview to capture what success looks like.')}</span>${peoplePreview}<span class="project-card-due ${overdue ? 'overdue' : ''}">${overdue ? 'Overdue · ' : ''}${escapeHtml(due)}</span>${total ? `<span class="project-progress-track"><i style="width:${progress}%"></i></span><span class="project-progress-label">${completed} of ${total} milestones</span>` : ''}<span class="project-linked-task-count">${linkedTaskCount} project task${linkedTaskCount === 1 ? '' : 's'}</span>${taskPreview}</button><div class="project-card-footer"><span>${project.updatedAt ? `Updated ${escapeHtml(new Date(project.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}` : ''}</span><button type="button" class="project-open-note" data-open-project="${escapeHtml(project.relativePath)}" aria-label="Open ${escapeHtml(project.title)} in Obsidian">↗</button></div></article>`;
  }).join('');
}

function projectPeopleNames(paths = []) {
  const normalize = (value) => String(value || '').replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').replace(/\\/g, '/').toLowerCase();
  return (paths || []).map((value) => state.people.find((person) => normalize(person.relativePath) === normalize(value) || normalize(person.title) === normalize(value))?.title || normalize(value).split('/').pop()).filter(Boolean);
}

function projectTaskCandidates() {
  const todoist = [...new Map(Object.values(state.tasksByQuadrant).flat().map((task) => [String(task.id), task])).values()]
    .map((task) => ({ source: 'todoist', id: String(task.id), title: task.content || 'Untitled task', dueDate: task.due?.date || task.due?.datetime || '', priority: normalizedTaskPriority(task, 'todoist'), task }));
  const obsidian = state.obsidianTasks.map((task) => ({ source: 'obsidian', relativePath: task.relativePath, text: task.text, title: task.displayText || task.text, people: task.people || [], dueDate: task.dueDate || '', priority: normalizedTaskPriority(task, 'obsidian'), task }));
  const reminders = state.reminders.map((task) => ({ source: 'reminder', id: String(task.id), title: task.title || 'Untitled reminder', dueDate: task.dueDate || '', priority: normalizedTaskPriority(task, 'reminder'), task }));
  return [...todoist, ...obsidian, ...reminders];
}

function projectTaskKey(task) {
  return task.source === 'obsidian'
    ? `obsidian:${task.relativePath}\u0000${task.text}`
    : `${task.source}:${task.id}`;
}

function projectDateOffset(date, offset) {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + offset);
  return localDateString(value);
}

function renderProjectTaskPicker(project = null, selector = '#project-task-management-options', filter = 'all', query = '', selectedKeys = null) {
  const options = $(selector);
  const candidates = projectTaskCandidates();
  const selected = selectedKeys || new Set((project?.taskLinks || []).map(projectTaskKey));
  const visible = candidates.map((task, index) => ({ task, index }))
    .filter(({ task }) => filter === 'all' || task.source === filter)
    .filter(({ task }) => !query || `${task.title} ${task.source === 'obsidian' ? task.relativePath : ''}`.toLowerCase().includes(query.toLowerCase()));
  if (!visible.length) {
    const emptyText = candidates.length ? 'No tasks match this view.' : 'No open tasks are loaded yet. Refresh Tasks and return here to choose project tasks.';
    options.innerHTML = `<span class="project-task-empty">${emptyText}</span>`;
    return;
  }
  if (!candidates.length) {
    options.innerHTML = '<span class="project-task-empty">No open tasks are loaded yet. Refresh Tasks and reopen this project to link them.</span>';
    return;
  }
  const sourceLabels = { todoist: 'Todoist', obsidian: 'Obsidian', reminder: 'Apple' };
  options.innerHTML = visible.map(({ task, index }) => `<label class="project-task-option"><input type="checkbox" data-project-task-index="${index}" ${selected.has(projectTaskKey(task)) ? 'checked' : ''}><span><strong>${escapeHtml(task.title)}</strong><small>${sourceLabels[task.source]}${task.dueDate ? ` · Due ${escapeHtml(String(task.dueDate).slice(0, 10))}` : ''}${task.source === 'obsidian' ? ` · ${escapeHtml(task.relativePath)}` : ''}</small></span><i class="task-origin-tag ${task.source === 'reminder' ? 'reminders' : task.source}">${sourceLabels[task.source]}</i></label>`).join('');
}

function renderProjectTaskManagement() {
  if (!state.selectedProject) return;
  renderProjectTaskPicker(state.selectedProject, '#project-task-management-options', state.projectTaskFilter, $('#project-task-search').value.trim(), state.projectTaskDraft);
  $$('[data-project-task-source]').forEach((button) => {
    const selected = button.dataset.projectTaskSource === state.projectTaskFilter;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  $('#project-task-management-count').textContent = `${state.projectTaskDraft.size} selected`;
}

function openProjectTaskManagement(project) {
  state.selectedProject = project;
  state.projectTaskFilter = 'all';
  state.projectTaskDraft = new Set((project.taskLinks || []).map(projectTaskKey));
  $('#project-task-management-title').textContent = `Tasks · ${project.title}`;
  $('#project-task-management-subtitle').textContent = 'Choose the tasks that belong to this project.';
  $('#projects-board-content').classList.add('hidden');
  $('#project-detail-page').classList.add('hidden');
  $('#project-task-management-page').classList.remove('hidden');
  $('#project-task-search').value = '';
  renderProjectTaskManagement();
}

function renderProjectDetail(project) {
  state.selectedProject = project;
  const candidates = projectTaskCandidates();
  const candidateMap = new Map(candidates.map((task) => [projectTaskKey(task), task]));
  const links = project.taskLinks || [];
  const linkedTasks = links.map((link) => candidateMap.get(projectTaskKey(link))).filter(Boolean);
  const todayTasks = linkedTasks.filter((task) => task.dueDate && String(task.dueDate).slice(0, 10) === state.date);
  const overdueTasks = linkedTasks.filter((task) => task.dueDate && String(task.dueDate).slice(0, 10) < state.date);
  const dueSoon = linkedTasks.filter((task) => task.dueDate && String(task.dueDate).slice(0, 10) > state.date && String(task.dueDate).slice(0, 10) <= projectDateOffset(state.date, 7));
  const doneMilestones = project.milestones.filter((item) => item.done).length;
  $('#project-detail-title').textContent = project.title;
  $('#project-detail-subtitle').textContent = [project.status[0].toUpperCase() + project.status.slice(1), project.dueDate ? `Target ${prettyDate(project.dueDate, { month: 'short', day: 'numeric' })}` : 'No target date'].join(' · ');
  const peopleNames = projectPeopleNames(project.people);
  $('#project-detail-people').classList.toggle('hidden', peopleNames.length === 0);
  $('#project-detail-people').innerHTML = peopleNames.length ? `<span class="eyebrow">PEOPLE</span><div>${peopleNames.map((name) => `<span class="project-person-chip">${escapeHtml(name)}</span>`).join('')}</div>` : '';
  $('#project-detail-stats').innerHTML = `<div><strong>${linkedTasks.length}</strong><span>open tasks</span></div><div><strong>${todayTasks.length + overdueTasks.length}</strong><span>need attention</span></div><div><strong>${dueSoon.length}</strong><span>due this week</span></div><div><strong>${doneMilestones}/${project.milestones.length}</strong><span>milestones</span></div>`;
  $('#project-detail-overview').innerHTML = project.overview ? `<span class="eyebrow">PROJECT OUTCOME</span><p>${escapeHtml(project.overview)}</p>` : '';
  const groups = { do: [], schedule: [], delegate: [], later: [] };
  for (const task of linkedTasks) {
    const important = task.priority >= 3;
    const urgent = taskUrgency(task.dueDate);
    const quadrant = important ? (urgent ? 'do' : 'schedule') : (urgent ? 'delegate' : 'later');
    groups[quadrant].push(task);
  }
  const focusLabels = { do: 'Do first', schedule: 'Schedule', delegate: 'Handle soon', later: 'Later' };
  const focusDescriptions = { do: 'Important · due within 7 days', schedule: 'Important · due later or no date', delegate: 'Lower priority · due within 7 days', later: 'Lower priority · due later or no date' };
  for (const [key, tasks] of Object.entries(groups)) {
    tasks.sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') || b.priority - a.priority || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    const tab = $(`[data-project-focus="${key}"]`);
    tab.classList.toggle('active', state.activeProjectTaskFocus === key);
    tab.setAttribute('aria-selected', String(state.activeProjectTaskFocus === key));
    $(`[data-project-focus-count="${key}"]`).textContent = String(tasks.length);
  }
  const source = { todoist: ['Todoist', 'todoist'], obsidian: ['Obsidian', 'obsidian'], reminder: ['Apple', 'reminders'] };
  const activeFocus = state.activeProjectTaskFocus in groups ? state.activeProjectTaskFocus : 'do';
  state.activeProjectTaskFocus = activeFocus;
  const activeTasks = groups[activeFocus];
  const groupMarkup = activeTasks.length ? `<section class="project-task-group project-task-focus-group"><header><div><h4>${focusLabels[activeFocus]}</h4><span>${focusDescriptions[activeFocus]}</span></div><span>${activeTasks.length}</span></header>${activeTasks.map((task) => {
    const [label, className] = source[task.source];
    const dueText = task.dueDate ? prettyDate(String(task.dueDate).slice(0, 10), { month: 'short', day: 'numeric' }) : '';
    const priorityText = ({ 1: 'Normal', 2: 'Medium', 3: 'High', 4: 'Urgent' })[task.priority] || 'Normal';
    const openAttrs = task.source === 'obsidian' ? `data-open-project-task="obsidian" data-task-file="${escapeHtml(task.relativePath)}"` : `data-open-project-task="${task.source}" data-task-id="${escapeHtml(task.id)}"`;
    return `<article class="project-task-card"><span class="project-task-priority-dot priority-${task.priority}" aria-hidden="true"></span><div class="project-task-card-copy"><strong>${escapeHtml(task.title)}</strong><span>${dueText ? `Due ${escapeHtml(dueText)} · ` : ''}${priorityText}</span></div><span class="task-origin-tag ${className}">${label}</span><button type="button" class="task-open-link" ${openAttrs} aria-label="Open ${escapeHtml(task.title)} in ${label}" title="Open in ${label}">↗</button></article>`;
  }).join('')}</section>` : `<div class="project-task-focus-empty">${linkedTasks.length ? `No ${focusLabels[activeFocus].toLowerCase()} tasks in this project.` : `<strong>${links.length ? 'Project tasks are not loaded' : 'No tasks assigned yet'}</strong><span>${links.length ? 'Refresh the Tasks module to load these tasks.' : 'Use Manage tasks to add work from Todoist, Obsidian, or Apple Reminders.'}</span>`}</div>`;
  $('#project-detail-task-groups').innerHTML = groupMarkup;
  $('#projects-board-content').classList.add('hidden');
  $('#project-task-management-page').classList.add('hidden');
  $('#project-detail-page').classList.remove('hidden');
}

async function loadProjects() {
  if (!state.config?.vaultPath) {
    state.projects = [];
    renderProjects();
    return;
  }
  try { state.projects = await window.daybook.listProjects(); }
  catch (error) { state.projects = []; showToast(`Projects: ${error.message}`, true); }
  renderProjects();
}

async function openProjectEditor(project = null) {
  if (!state.people?.length) state.people = await window.daybook.listPeople().catch(() => []);
  state.editingProject = project;
  $('#project-editor-title').textContent = project ? 'Edit project' : 'New project';
  $('#project-name').value = project?.title || '';
  $('#project-status').value = project?.status || 'active';
  $('#project-priority').value = project?.priority || 'normal';
  $('#project-start-date').value = project?.startDate || '';
  $('#project-due-date').value = project?.dueDate || '';
  $('#project-overview').value = project?.overview || '';
  $('#project-milestones').value = (project?.milestones || []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n');
  renderProjectPeopleChoices(project?.people || []);
  $('#project-open-note').classList.toggle('hidden', !project);
  $('#project-save').textContent = project ? 'Save changes' : 'Create project';
  $('#project-editor-modal').classList.remove('hidden');
  $('#project-name').focus();
}

function openNativeTaskComposer(source) {
  state.activeTaskCreateSource = source;
  const isApple = source === 'reminder';
  $('#native-task-source').textContent = isApple ? 'APPLE REMINDERS' : 'OBSIDIAN';
  $('#native-task-title').textContent = isApple ? 'New Apple reminder' : 'New Obsidian task';
  $('#native-task-label').firstChild.textContent = isApple ? 'Reminder name' : 'Task name';
  $('#native-task-name').value = '';
  $('#native-task-date').value = '';
  $('#native-task-priority').value = '1';
  $('#native-task-status').textContent = isApple ? 'This will go to your default Apple Reminders list.' : `This will be added to the ${prettyDate(state.date, { month: 'long', day: 'numeric' })} daily note.`;
  $('#native-task-save').textContent = isApple ? 'Add reminder' : 'Add task';
  $('#native-task-modal').classList.remove('hidden');
  $('#native-task-name').focus();
}

async function openCreateMeetingModal() {
  const date = state.selectedMeetingDate || state.date;
  $('#create-meeting-form').reset();
  $('#create-meeting-type').value = 'Other Meeting';
  await loadPeople();
  renderMeetingPeopleChoices();
  $('#create-meeting-date').value = date;
  $('#create-meeting-start').value = '09:00';
  $('#create-meeting-end').value = '10:00';
  $('#create-meeting-status').textContent = '';
  $('#create-meeting-modal').classList.remove('hidden');
  $('#create-meeting-name').focus();
}

function renderMeetingEditor() {
  const note = state.activeMeetingNote;
  if (!note) return;
  $('#meeting-editor-title').textContent = note.title;
  const date = note.date ? prettyDate(note.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const time = note.start ? new Date(note.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  $('#meeting-editor-meta').textContent = [date, time, note.calendar, note.location].filter(Boolean).join(' · ');
  renderMeetingMetadata(note);
  $('#meeting-agenda-input').value = note.agenda || '';
  $('#meeting-notes-input').value = note.notes;
  $('#meeting-action-items-input').value = note.actionItems || '';
  $('#one-on-one-related-work').classList.toggle('hidden', note.meetingType !== 'One on One');
  if (note.meetingType === 'One on One') renderOneOnOneRelatedWork(note).catch((error) => showToast(`Related work: ${error.message}`, true));
  $('#meeting-editor-status').textContent = 'All changes saved to Obsidian.';
  $('#meeting-editor-reload').classList.add('hidden');
}

async function renderOneOnOneRelatedWork(note) {
  const section = $('#one-on-one-related-work');
  section.classList.remove('hidden');
  $('#one-on-one-projects').innerHTML = '<p class="one-on-one-related-empty">Loading linked projects…</p>';
  $('#one-on-one-tasks').innerHTML = '<p class="one-on-one-related-empty">Loading open tasks…</p>';
  const [projects, taskData, reminders] = await Promise.all([
    window.daybook.listProjects(),
    window.daybook.listTasks().catch(() => ({ tasksByQuadrant: {} })),
    window.daybook.listReminders().catch(() => ({ reminders: [] }))
  ]);
  state.projects = projects;
  state.tasksByQuadrant = taskData.tasksByQuadrant || state.tasksByQuadrant;
  state.todoistDueToday = taskData.dueToday || state.todoistDueToday;
  state.obsidianTasks = await window.daybook.listObsidianTasks();
  state.reminders = reminders.reminders || [];
  const pathFor = (value) => String(value || '').replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '').replace(/\\/g, '/').toLowerCase();
  const personRefs = (note.people || []).map(pathFor);
  const people = state.people?.length ? state.people : await window.daybook.listPeople();
  state.people = people;
  const personNames = people.filter((person) => personRefs.includes(pathFor(person.relativePath)) || personRefs.includes(pathFor(person.title))).map((person) => person.title);
  $('#one-on-one-related-title').textContent = personNames.length ? `Projects & tasks with ${personNames.join(', ')}` : 'Projects & tasks';
  const linked = (refs) => (refs || []).some((ref) => {
    const key = pathFor(ref);
    return personRefs.includes(key) || personNames.some((name) => key === pathFor(name));
  });
  const personProjects = projects.filter((project) => linked(project.people));
  const candidates = projectTaskCandidates();
  const projectTaskKeys = new Set(personProjects.flatMap((project) => (project.taskLinks || []).map(projectTaskKey)));
  const personTasks = candidates.filter((task) => projectTaskKeys.has(projectTaskKey(task)) || (task.source === 'obsidian' && linked(task.people)) || people.some((person) => personNames.includes(person.title) && (person.taskLinks || []).includes(taskPersonKey(task.source, task))));
  const empty = (message) => `<p class="one-on-one-related-empty">${message}</p>`;
  $('#one-on-one-projects').innerHTML = personProjects.length ? personProjects.map((project) => `<button type="button" class="one-on-one-related-row" data-one-on-one-note="${escapeHtml(project.relativePath)}"><span><strong>${escapeHtml(project.title)}</strong><small>${escapeHtml(project.status || 'Project')}</small></span><i>↗</i></button>`).join('') : empty(personNames.length ? 'No projects are linked to this person yet.' : 'Link a person to this One on One to see their projects.');
  $('#one-on-one-tasks').innerHTML = personTasks.length ? personTasks.map((task) => task.source === 'obsidian' ? `<button type="button" class="one-on-one-related-row" data-one-on-one-note="${escapeHtml(task.relativePath)}"><span><strong>${escapeHtml(task.title)}</strong><small>Obsidian task</small></span><i>↗</i></button>` : `<button type="button" class="one-on-one-related-row" data-one-on-one-task="${escapeHtml(task.source)}" data-one-on-one-task-id="${escapeHtml(task.id)}"><span><strong>${escapeHtml(task.title)}</strong><small>${task.source === 'reminder' ? 'Apple Reminders' : 'Todoist'}${task.dueDate ? ` · Due ${escapeHtml(String(task.dueDate).slice(0, 10))}` : ''}</small></span><i>↗</i></button>`).join('') : empty(personNames.length ? 'No open tasks are linked to this person yet.' : 'Link a person to this One on One to see their tasks.');
}

function renderMeetingMetadata(note) {
  const grid = $('#meeting-metadata-grid');
  grid.replaceChildren();
  const date = note.date ? prettyDate(note.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const formatTime = (value) => value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const time = note.allDay ? 'All day' : [formatTime(note.start), formatTime(note.end)].filter(Boolean).join(' – ');
  const attendees = (note.attendees || []).map((attendee) => attendee.name || attendee.url).filter(Boolean).join(', ');
  const fields = [
    ['Type', note.meetingType], ['People', (note.people || []).map((person) => {
      const relativePath = person.replace(/^\[\[|\]\]$/g, '').replace(/\.md$/i, '');
      return state.people.find((item) => item.relativePath.replace(/\.md$/i, '') === relativePath)?.title || relativePath.split('/').pop();
    }).join(', ')],
    ['Date', date], ['Time', time], ['Calendar', note.calendar], ['Location', note.location],
    [note.zoomUrl ? 'Zoom URL' : 'Meeting URL', note.zoomUrl || note.url],
    ['Attendees', attendees], ['Organizer', note.organizer?.name || note.organizer?.url],
    ['Event details', note.eventNotes]
  ].filter(([, value]) => String(value || '').trim());
  for (const [label, value] of fields) {
    const item = document.createElement('div');
    item.className = 'meeting-metadata-item';
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    item.append(term, description);
    grid.append(item);
  }
  $('#meeting-metadata-grid').closest('.meeting-metadata').classList.toggle('hidden', fields.length === 0);
}

async function openMeetingNote(relativePath, skipSaving = false) {
  if (!skipSaving && state.activeMeetingNote?.relativePath === relativePath) {
    setActiveView('meetings');
    return;
  }
  if (!skipSaving && state.activeMeetingNote?.relativePath !== relativePath && state.activeMeetingNote) {
    await saveMeetingNote();
    if ($('#meeting-editor-reload').classList.contains('hidden') === false) return;
  }
  setActiveView('meetings');
  try {
    const note = await window.daybook.getMeetingNote(relativePath);
    state.activeMeetingNote = { ...note, savePromise: null };
    renderMeetingEditor();
    renderMeetingNotes();
  } catch (error) { showToast(`Meeting note: ${error.message}`, true); }
}

async function saveMeetingNote() {
  const note = state.activeMeetingNote;
  if (!note) return;
  clearTimeout(state.meetingSaveTimer);
  if (note.savePromise) {
    await note.savePromise;
    if (state.activeMeetingNote === note && (
      $('#meeting-agenda-input').value !== note.agenda ||
      $('#meeting-notes-input').value !== note.notes ||
      $('#meeting-action-items-input').value !== note.actionItems
    )) return saveMeetingNote();
    return;
  }
  const agenda = $('#meeting-agenda-input').value;
  const text = $('#meeting-notes-input').value;
  const actionItems = $('#meeting-action-items-input').value;
  if (agenda === note.agenda && text === note.notes && actionItems === note.actionItems) {
    $('#meeting-editor-status').textContent = 'All changes saved to Obsidian.';
    return;
  }
  const button = $('#meeting-editor-save');
  button.disabled = true;
  $('#meeting-editor-status').textContent = 'Saving to Obsidian…';
  note.savePromise = window.daybook.saveMeetingNote(note.relativePath, agenda, text, actionItems, note.expectedContent);
  try {
    const result = await note.savePromise;
    note.expectedContent = result.expectedContent;
    note.agenda = agenda;
    note.notes = text;
    note.actionItems = actionItems;
    $('#meeting-editor-status').textContent = 'All changes saved to Obsidian.';
    $('#meeting-editor-reload').classList.add('hidden');
    if ($('#meeting-agenda-input').value !== agenda || $('#meeting-notes-input').value !== text || $('#meeting-action-items-input').value !== actionItems) scheduleMeetingNoteSave();
  } catch (error) {
    $('#meeting-editor-status').textContent = error.message;
    $('#meeting-editor-reload').classList.remove('hidden');
    showToast(error.message, true);
  } finally {
    note.savePromise = null;
    button.disabled = false;
  }
}

async function addMeetingActionTask() {
  const note = state.activeMeetingNote;
  if (!note) return;
  const input = $('#meeting-action-items-input');
  const lines = input.value.split(/\r?\n/);
  const selection = input.value.slice(input.selectionStart, input.selectionEnd).trim();
  let action = selection;
  if (!action) {
    const cursor = input.selectionStart;
    const line = input.value.slice(0, cursor).split(/\r?\n/).length - 1;
    action = (lines[line]?.trim() || lines.find((entry) => entry.trim()) || '').trim();
  }
  if (!action) {
    showToast('Add an action item first.', true);
    input.focus();
    return;
  }
  const actionLines = action.split(/\r?\n/);
  const content = actionLines.shift().replace(/^[-*•]\s*/, '').trim();
  const description = [
    actionLines.join('\n').trim(),
    `Meeting: ${note.title}`,
    note.date ? `Date: ${prettyDate(note.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}` : '',
    note.url ? `Meeting URL: ${note.url}` : ''
  ].filter(Boolean).join('\n\n');
  if (!content) {
    showToast('Choose an action item with a task description.', true);
    return;
  }
  await openTodoistTaskComposer(content, description);
}

function scheduleMeetingNoteSave() {
  clearTimeout(state.meetingSaveTimer);
  $('#meeting-editor-status').textContent = 'Unsaved changes';
  state.meetingSaveTimer = setTimeout(() => saveMeetingNote(), 800);
}

async function loadWork() {
  const todoistEnabled = state.config?.modules?.todoist !== false;
  const wrikeEnabled = state.config?.modules?.wrike !== false;
  const serviceNowEnabled = state.config?.modules?.serviceNow !== false;
  const [todoist, obsidian, reminders, wrike, serviceNow] = await Promise.all([
    todoistEnabled ? window.daybook.listTasks().catch((error) => ({ connected: Boolean(state.config.todoistToken), configured: false, tasksByQuadrant: {}, error: error.message })) : Promise.resolve({ connected: false, configured: false, tasksByQuadrant: {}, dueToday: [] }),
    window.daybook.listObsidianTasks().catch((error) => ({ tasks: [], error: error.message })),
    window.daybook.listReminders().catch((error) => ({ supported: true, reminders: [], error: error.message })),
    wrikeEnabled ? window.daybook.listWrikeTasks().catch((error) => ({ tasks: [], error: error.message })) : Promise.resolve({ tasks: [] }),
    serviceNowEnabled ? window.daybook.listServiceNowTasks().catch((error) => ({ tasks: [], error: error.message })) : Promise.resolve({ tasks: [] })
  ]);
  state.connected = Boolean(todoist.connected);
  state.filtersConfigured = Boolean(todoist.configured);
  state.tasksByQuadrant = todoist.tasksByQuadrant || { do: [], schedule: [], delegate: [], later: [] };
  state.todoistDueToday = todoist.dueToday || [];
  state.obsidianTasks = Array.isArray(obsidian) ? obsidian : (obsidian.tasks || []);
  state.reminders = reminders.reminders || [];
  state.wrikeTasks = wrike.tasks || [];
  state.serviceNowTasks = serviceNow.tasks || [];
  state.remindersSupported = Boolean(reminders.supported);
  renderTasks();
  renderObsidianTasks();
  renderReminders();
  renderTodaySelectedTasks();
  renderTodayPlan();
  renderTaskSourceTabs();
  renderUnifiedTasks();
  renderProjects();
  if (todoist.error) showToast(`Todoist: ${todoist.error}`, true);
  if (obsidian.error) showToast(`Obsidian tasks: ${obsidian.error}`, true);
  if (reminders.error) showToast(`Apple Reminders: ${reminders.error}`, true);
  if (wrike.error) showToast(`Wrike: ${wrike.error}`, true);
  if (serviceNow.error) showToast(`ServiceNow: ${serviceNow.error}`, true);
}

async function refreshReminders() {
  try {
    const result = await window.daybook.listReminders();
    state.reminders = result.reminders || [];
    state.remindersSupported = Boolean(result.supported);
    renderReminders();
    renderTodaySelectedTasks();
    renderTodayPlan();
    renderObsidianTasks();
    renderTaskSourceTabs();
    renderProjects();
    renderUnifiedTasks();
  } catch (error) { showToast(`Apple Reminders: ${error.message}`, true); }
}

async function refreshObsidianTasks() {
  try {
    state.obsidianTasks = await window.daybook.listObsidianTasks();
    renderObsidianTasks();
    renderTodaySelectedTasks();
    renderTodayPlan();
    renderTaskSourceTabs();
    renderUnifiedTasks();
    renderProjects();
    renderProjects();
  } catch (error) { showToast(error.message, true); }
}

async function refreshCalendarEvents(date = state.date) {
  state.calendarLoading = true;
  state.calendarEvents = [];
  state.calendarError = '';
  if (date === state.date) renderTodayPlan();
  try {
    const result = await window.daybook.listCalendarEvents(date);
    if (date !== state.date) return;
    state.calendarLoading = false;
    state.calendarSupported = Boolean(result.supported);
    state.calendarAccessDenied = result.authorized === false;
    state.calendarEvents = result.events || [];
  } catch (error) {
    if (date !== state.date) return;
    state.calendarLoading = false;
    state.calendarSupported = true;
    state.calendarEvents = [];
    state.calendarAccessDenied = false;
    state.calendarError = error.message || 'Calendar access is unavailable.';
    console.error('Calendar access:', error);
  }
  renderTodayPlan();
}

async function requestCalendarAccess() {
  if (!state.calendarSupported) return;
  try {
    state.config = await window.daybook.saveConfig({ ...state.config, calendarEnabled: true });
    const permission = await window.daybook.requestCalendarAccess();
    state.calendarAccessDenied = permission.authorized === false;
    await refreshCalendarEvents();
    if (state.calendarAccessDenied) showToast('Allow Daybook under Privacy & Security → Calendars, then try again.');
  } catch (error) {
    state.calendarError = error.message;
    renderTodayPlan();
    showToast(error.message, true);
  }
}

async function refreshHabits() {
  const modules = state.config?.modules || {};
  const [habits, protocolItems, protocolBundles, committedProtocol, protocolCycles] = await Promise.all([
    modules.habits === false ? Promise.resolve([]) : window.daybook.listHabits(),
    modules.wellness === false ? Promise.resolve([]) : window.daybook.listProtocol(state.date),
    modules.wellness === false ? Promise.resolve([]) : window.daybook.listProtocolBundles(),
    modules.wellness === false ? Promise.resolve({ relativePaths: [] }) : window.daybook.listCommittedProtocol(state.date),
    modules.wellness === false ? Promise.resolve([]) : window.daybook.listProtocolCycles()
  ]);
  state.habits = habits;
  state.protocolItems = protocolItems;
  state.protocolBundles = protocolBundles;
  state.protocolCycles = protocolCycles;
  state.committedProtocolPaths = committedProtocol.relativePaths || [];
  state.committedProtocolName = committedProtocol.name || '';
  state.committedProtocolTime = committedProtocol.time || '';
  state.committedProtocolTimings = committedProtocol.itemTimings || {};
  state.committedProtocolFrequencies = committedProtocol.itemFrequencies || {};
  renderProtocolBundles();
  renderProtocolCycles();
  $('#nav-habit-count').textContent = String(state.config?.modules?.wellness !== false ? state.committedProtocolPaths.length : state.habits.length);
  renderProtocolCalendar();
  renderTodayPlan();
}

async function refreshHevyWorkouts() {
  if (state.config?.modules?.hevy === false) {
    state.hevyLoaded = true;
    state.hevyLoading = false;
    state.hevyConnected = false;
    state.hevyWorkouts = [];
    if (state.activeView === 'workouts') renderWorkoutDashboard();
    return;
  }
  state.hevyLoading = true;
  try {
    const result = await window.daybook.listHevyWorkouts();
    state.hevyConnected = result.connected;
    state.hevyWorkouts = result.workouts || [];
    state.hevyCachedAt = result.cachedAt || '';
    state.hevyFromCache = Boolean(result.fromCache);
    state.hevyError = result.error || '';
  } catch (error) {
    state.hevyError = error.message;
  } finally {
    state.hevyLoaded = true;
    state.hevyLoading = false;
  }
  if (state.activeView === 'workouts') renderWorkoutDashboard();
}

async function loadCachedHevyWorkouts() {
  try {
    const result = await window.daybook.getCachedHevyWorkouts();
    state.hevyConnected = result.connected;
    state.hevyWorkouts = result.workouts || [];
    state.hevyCachedAt = result.cachedAt || '';
    state.hevyFromCache = Boolean(result.fromCache);
    state.hevyError = result.error || '';
    if (state.activeView === 'workouts') renderWorkoutDashboard();
  } catch {
    // A missing or unreadable cache should not prevent a fresh Hevy sync.
  }
}

async function loadDate(date) {
  state.date = date;
  state.protocolCalendarMonth = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1);
  setSaveStatus('saving', 'Opening your day…');
  try {
    const record = await window.daybook.getDay(date);
    state.notePath = record.relativePath;
    state.noteBlock = record.block || '';
    state.day = record.day;
    renderToday();
    renderTodaySelectedTasks();
    if (state.activeView === 'work') {
      renderTasks();
      renderObsidianTasks();
      renderReminders();
    }
    await refreshHabits();
    if (state.config.calendarEnabled) refreshCalendarEvents(date);
    setSaveStatus('saved', 'All changes saved');
  } catch (error) {
    setSaveStatus('error', 'Could not open this day');
    showToast(error.message, true);
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  const saveDate = state.date;
  const saveDay = JSON.parse(JSON.stringify(state.day));
  const expectedBlock = state.noteBlock;
  setSaveStatus('saving', 'Saving to your vault…');
  state.saveTimer = setTimeout(async () => {
    try {
      const saved = await window.daybook.saveDay(saveDate, saveDay, expectedBlock);
      if (state.date === saveDate) {
        state.notePath = saved.relativePath;
        state.noteBlock = saved.block || '';
        $('#daily-note-path').textContent = `↳ ${state.notePath}`;
        setSaveStatus('saved', 'All changes saved');
      }
    } catch (error) {
      if (state.date === saveDate) setSaveStatus('error', 'Could not save');
      showToast(error.message, true);
    }
  }, 450);
}

async function toggleHabit(input) {
  input.disabled = true;
  try {
    await window.daybook.toggleHabit(input.dataset.habit, state.date);
    await refreshHabits();
    showToast(input.checked ? 'Habit check-in saved to its note.' : 'Check-in removed.');
  } catch (error) {
    input.checked = !input.checked;
    showToast(error.message, true);
  } finally {
    input.disabled = false;
  }
}

async function openSettings() {
  $('#settings-vault-path').textContent = state.config.vaultPath || 'No vault selected';
  $('#daily-folder-setting').value = state.config.dailyFolder || 'Daily';
  $('#attachments-folder-setting').value = state.config.attachmentsFolder || 'Attachments';
  $('#habits-folder-setting').value = state.config.habitsFolder || 'Habits';
  $('#wellness-folder-setting').value = state.config.wellnessFolder || 'Wellness';
  $('#projects-folder-setting').value = state.config.projectsFolder || 'PROJECTS';
  $('#meetings-folder-setting').value = state.config.meetingsFolder || 'MEETINGS';
  $('#people-folder-setting').value = state.config.peopleFolder || 'People';
  $('#todoist-token').value = state.config.todoistToken || '';
  $('#hevy-api-key').value = state.config.hevyApiKey || '';
  $('#wrike-host').value = state.config.wrikeHost || 'https://www.wrike.com';
  $('#wrike-token').value = state.config.wrikeToken || '';
  $('#servicenow-instance').value = state.config.serviceNowInstance || '';
  $('#servicenow-user').value = state.config.serviceNowUser || '';
  $('#servicenow-auth-type').value = state.config.serviceNowAuthType || 'apiKey';
  $('#servicenow-token').value = state.config.serviceNowToken || '';
  $('#servicenow-password').value = state.config.serviceNowPassword || '';
  updateServiceNowAuthFields();
  const modules = state.config.modules || {};
  $('#module-habits').checked = modules.habits !== false;
  $('#module-wellness').checked = modules.wellness !== false;
  $('#module-todoist').checked = modules.todoist !== false;
  $('#module-wrike').checked = modules.wrike !== false;
  $('#module-serviceNow').checked = modules.serviceNow !== false;
  $('#module-hevy').checked = modules.hevy !== false;
  $('#appearance-mode').value = state.config.appearance?.mode || 'system';
  $('#appearance-color').value = state.config.appearance?.color || 'blue';
  $('#settings-status').textContent = '';
  $('#settings-modal').classList.remove('hidden');
}

function updateServiceNowAuthFields() {
  const authType = $('#servicenow-auth-type').value;
  const tokenField = $('#servicenow-token-field');
  const passwordField = $('#servicenow-password-field');
  tokenField.classList.toggle('hidden', authType === 'basic');
  passwordField.classList.toggle('hidden', authType !== 'basic');
  tokenField.firstChild.textContent = authType === 'bearer' ? 'OAuth bearer token' : 'API key';
  const input = $('#servicenow-token');
  input.placeholder = authType === 'bearer' ? 'Paste your OAuth access token' : 'Paste your ServiceNow API key';
}

async function chooseVault() {
  const config = await window.daybook.chooseVault();
  if (!config) return;
  state.config = config;
  $('#settings-vault-path').textContent = config.vaultPath;
  $('#setup-view').classList.add('hidden');
  setActiveView('today');
  updateVaultLabel();
  await refreshHabits();
  await loadDate(state.date);
  await loadWork();
  await loadMeetingNotes();
  await loadProjects();
}

function updateVaultLabel() {
  const label = $('#vault-label');
  label.textContent = state.config.vaultPath ? state.config.vaultPath.split(/[\\/]/).filter(Boolean).pop() : 'No vault connected';
  $('.status-dot').classList.toggle('connected', Boolean(state.config.vaultPath));
}

async function init() {
  state.config = await window.daybook.getConfig();
  state.config.modules ||= { habits: true, wellness: true, todoist: true, hevy: true, wrike: true, serviceNow: true };
  state.config.appearance ||= { mode: 'system', color: 'blue' };
  applyAppearance();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.config.appearance?.mode === 'system') applyAppearance();
  });
  state.calendarSupported = Boolean(state.config.calendarSupported);
  applyModuleVisibility();
  renderTaskSourceTabs();
  updateVaultLabel();
  if (!state.config.vaultPath) {
    $('#today-view').classList.add('hidden');
    $('#setup-view').classList.remove('hidden');
  } else {
    await refreshHabits();
    await loadDate(state.date);
    await loadWork();
    await loadMeetingNotes();
    await loadPeople();
    await loadProjects();
  }

  $$('.nav-item, .panel-link').forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
  $('#projects-empty').addEventListener('click', (event) => { if (event.target.closest('[data-create-project]')) openProjectEditor(); });
  $('#project-status-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project-filter]');
    if (!button) return;
    state.activeProjectFilter = button.dataset.projectFilter;
    renderProjects();
  });
  $('#projects-search').addEventListener('input', renderProjects);
  $('#projects-list').addEventListener('click', async (event) => {
    const open = event.target.closest('[data-open-project]');
    if (open) { await window.daybook.openNote(open.dataset.openProject); return; }
    const detail = event.target.closest('[data-open-project-detail]');
    if (detail) {
      const project = state.projects.find((item) => item.relativePath === detail.dataset.openProjectDetail);
      if (project) renderProjectDetail(project);
      return;
    }
    const edit = event.target.closest('[data-edit-project]');
    if (edit) openProjectEditor(state.projects.find((project) => project.relativePath === edit.dataset.editProject));
  });
  $('#project-detail-back').addEventListener('click', () => {
    $('#project-detail-page').classList.add('hidden');
    $('#project-task-management-page').classList.add('hidden');
    $('#projects-board-content').classList.remove('hidden');
    state.selectedProject = null;
  });
  $('#project-detail-edit').addEventListener('click', () => {
    if (!state.selectedProject) return;
    const project = state.selectedProject;
    openProjectEditor(project);
  });
  $('#project-detail-open-note').addEventListener('click', async () => {
    if (state.selectedProject?.relativePath) await window.daybook.openNote(state.selectedProject.relativePath);
  });
  $('#project-detail-manage-tasks').addEventListener('click', () => {
    if (!state.selectedProject) return;
    openProjectTaskManagement(state.selectedProject);
  });
  const returnToProjectDetail = () => {
    $('#project-task-management-page').classList.add('hidden');
    $('#project-detail-page').classList.remove('hidden');
  };
  $('#project-task-management-back').addEventListener('click', returnToProjectDetail);
  $('#project-task-management-cancel').addEventListener('click', returnToProjectDetail);
  $('#project-task-source-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-project-task-source]');
    if (!button) return;
    state.projectTaskFilter = button.dataset.projectTaskSource;
    renderProjectTaskManagement();
  });
  $('#project-task-search').addEventListener('input', renderProjectTaskManagement);
  $('#project-task-management-options').addEventListener('change', (event) => {
    const input = event.target.closest('[data-project-task-index]');
    if (!input) return;
    const task = projectTaskCandidates()[Number(input.dataset.projectTaskIndex)];
    if (!task) return;
    if (input.checked) state.projectTaskDraft.add(projectTaskKey(task));
    else state.projectTaskDraft.delete(projectTaskKey(task));
    $('#project-task-management-count').textContent = `${state.projectTaskDraft.size} selected`;
  });
  $('#project-task-management-save').addEventListener('click', async () => {
    const project = state.selectedProject;
    if (!project) return;
    const button = $('#project-task-management-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const taskLinks = projectTaskCandidates().filter((task) => state.projectTaskDraft.has(projectTaskKey(task)));
      await window.daybook.saveProject({
        relativePath: project.relativePath,
        title: project.title,
        status: project.status,
        priority: project.priority,
        startDate: project.startDate,
        dueDate: project.dueDate,
        overview: project.overview,
        milestones: (project.milestones || []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n'),
        taskLinks,
        people: project.people || []
      });
      await loadProjects();
      const updated = state.projects.find((item) => item.relativePath === project.relativePath);
      if (updated) renderProjectDetail(updated);
      showToast('Project tasks saved to Obsidian.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; button.textContent = 'Save tasks'; }
  });
  $('#project-detail-task-groups').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-project-task]');
    if (!button) return;
    const source = button.dataset.openProjectTask;
    const action = source === 'obsidian'
      ? window.daybook.openNote(button.dataset.taskFile)
      : window.daybook.openNativeTask(source, button.dataset.taskId);
    action.catch((error) => showToast(error.message, true));
  });
  $('#project-detail-focus-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-project-focus]');
    if (!tab || !state.selectedProject) return;
    state.activeProjectTaskFocus = tab.dataset.projectFocus;
    renderProjectDetail(state.selectedProject);
  });
  $('#project-editor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#project-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await window.daybook.saveProject({
        relativePath: state.editingProject?.relativePath,
        title: $('#project-name').value,
        status: $('#project-status').value,
        priority: $('#project-priority').value,
        startDate: $('#project-start-date').value,
        dueDate: $('#project-due-date').value,
        overview: $('#project-overview').value,
        milestones: $('#project-milestones').value,
        taskLinks: state.editingProject?.taskLinks || [],
        people: $$('#project-people-choices input:checked').map((input) => input.value)
      });
      $('#project-editor-modal').classList.add('hidden');
      const detailPath = state.selectedProject?.relativePath;
      state.editingProject = null;
      await loadProjects();
      if (detailPath) {
        const updatedProject = state.projects.find((item) => item.relativePath === detailPath);
        if (updatedProject) renderProjectDetail(updatedProject);
      }
      showToast('Project saved to Obsidian.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; button.textContent = state.editingProject ? 'Save changes' : 'Create project'; }
  });
  $('#project-open-note').addEventListener('click', async () => {
    if (state.editingProject?.relativePath) await window.daybook.openNote(state.editingProject.relativePath);
  });
  $('#task-source-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-task-source]');
    if (button) setTaskSource(button.dataset.taskSource);
  });
  $('#aggregate-task-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-unified-quadrant]');
    if (!button) return;
    state.activeUnifiedQuadrant = button.dataset.unifiedQuadrant;
    renderUnifiedTasks();
  });
  $('#aggregate-task-refresh').addEventListener('click', loadWork);
  $('#task-properties-date').addEventListener('input', updateTaskFocusPreview);
  $('#task-properties-date').addEventListener('change', updateTaskFocusPreview);
  $('#task-properties-priority').addEventListener('change', updateTaskFocusPreview);
  $('#task-people-choices').addEventListener('change', updateTaskPeopleSummary);
  $('#task-properties-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const edit = state.activeTaskPropertyEdit;
    if (!edit) return;
    const save = $('#task-properties-save');
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const dueDate = $('#task-properties-date').value;
      const priority = Number($('#task-properties-priority').value);
      if (edit.source === 'todoist') await window.daybook.updateTask(edit.task.id, { dueDate, priority });
      else if (edit.source === 'reminder') await window.daybook.updateReminder(edit.task.id, dueDate, priority);
      else {
        await window.daybook.updateObsidianTaskProperties(edit.task.relativePath, edit.task.line, edit.task.text, dueDate, priority);
        await loadWork();
        const updatedTask = state.obsidianTasks.find((task) => task.relativePath === edit.task.relativePath
          && (task.displayText || task.text) === (edit.task.displayText || edit.task.text))
          || state.obsidianTasks.find((task) => task.relativePath === edit.task.relativePath && task.line === edit.task.line);
        if (!updatedTask) throw new Error('Task updated, but Daybook could not reload it to save the project link. Refresh Tasks and try again.');
        await saveObsidianTaskProject(edit.task, updatedTask, $('#task-properties-project').value);
      }
      const people = $$('#task-people-choices input:checked').map((input) => input.value);
      await window.daybook.setTaskPeople(taskPersonKey(edit.source, edit.task), people);
      $('#task-properties-modal').classList.add('hidden');
      state.activeTaskPropertyEdit = null;
      await loadWork();
      state.people = await window.daybook.listPeople();
      showToast('Task details and people saved.');
    } catch (error) {
      $('#task-properties-status').textContent = error.message;
      showToast(error.message, true);
    } finally {
      save.disabled = false;
      save.textContent = 'Save task';
    }
  });
  $('#aggregate-task-list').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-aggregate-complete]');
    if (!input) return;
    input.disabled = true;
    const source = input.dataset.aggregateComplete;
    try {
      if (source === 'todoist') {
        const task = Object.values(state.tasksByQuadrant).flat().find((item) => String(item.id) === input.dataset.taskId);
        await window.daybook.completeTask(input.dataset.taskId);
        if (task) removeWorkSelection('todoist', task);
      } else if (source === 'reminder') {
        const task = state.reminders.find((item) => String(item.id) === input.dataset.taskId);
        await window.daybook.completeReminder(input.dataset.taskId);
        if (task) removeWorkSelection('reminder', task);
      } else {
        const task = state.obsidianTasks.find((item) => item.relativePath === input.dataset.taskFile && item.text === input.dataset.taskText);
        await window.daybook.completeObsidianTask(input.dataset.taskFile, task?.line ?? Number(input.dataset.taskLine), input.dataset.taskText);
        if (task) removeWorkSelection('obsidian', task);
      }
      await loadWork();
    } catch (error) {
      input.checked = false;
      input.disabled = false;
      await loadWork();
      showToast(error.message, true);
    }
  });
  $('#settings-open').addEventListener('click', openSettings);
  $('#meetings-refresh').addEventListener('click', async () => {
    await loadMeetingNotes();
    await refreshMeetingCalendarEvents(state.meetingMonth, true);
  });
  $('#create-meeting-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#create-meeting-save');
    const date = $('#create-meeting-date').value;
    const start = new Date(`${date}T${$('#create-meeting-start').value}:00`);
    const end = new Date(`${date}T${$('#create-meeting-end').value}:00`);
    if (!date || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      $('#create-meeting-status').textContent = 'Choose a valid date and an end time after the start.';
      return;
    }
    button.disabled = true;
    button.textContent = 'Creating…';
    $('#create-meeting-status').textContent = 'Adding event to Apple Calendar and creating the Obsidian note…';
    try {
      const result = await window.daybook.createCalendarMeeting({
        title: $('#create-meeting-name').value,
        meetingType: $('#create-meeting-type').value,
        people: $$('#create-meeting-people input:checked').map((input) => input.value),
        start: start.toISOString(),
        end: end.toISOString(),
        location: $('#create-meeting-location').value,
        url: $('#create-meeting-url').value,
        agenda: $('#create-meeting-agenda').value
      });
      $('#create-meeting-modal').classList.add('hidden');
      state.selectedMeetingDate = date;
      state.meetingMonth = new Date(`${date}T12:00:00`);
      await loadMeetingNotes();
      await refreshMeetingCalendarEvents(state.meetingMonth, true);
      await openMeetingNote(result.relativePath);
      showToast('Meeting added to Apple Calendar and its note is ready.');
    } catch (error) {
      $('#create-meeting-status').textContent = error.message;
      showToast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Create meeting';
    }
  });
  $('#protocol-calendar-prev').addEventListener('click', () => {
    state.protocolCalendarMonth = new Date(state.protocolCalendarMonth.getFullYear(), state.protocolCalendarMonth.getMonth() - 1, 1);
    renderProtocolCalendar();
  });
  $('#protocol-calendar-next').addEventListener('click', () => {
    state.protocolCalendarMonth = new Date(state.protocolCalendarMonth.getFullYear(), state.protocolCalendarMonth.getMonth() + 1, 1);
    renderProtocolCalendar();
  });
  $('#protocol-calendar-grid').addEventListener('click', (event) => {
    const day = event.target.closest('[data-protocol-date]');
    if (day && day.dataset.protocolDate !== state.date) loadDate(day.dataset.protocolDate);
  });
  $('#meeting-month-prev').addEventListener('click', () => {
    state.meetingMonth = new Date(state.meetingMonth.getFullYear(), state.meetingMonth.getMonth() - 1, 1);
    state.selectedMeetingDate = '';
    renderMeetingNotes();
  });
  $('#meeting-month-next').addEventListener('click', () => {
    state.meetingMonth = new Date(state.meetingMonth.getFullYear(), state.meetingMonth.getMonth() + 1, 1);
    state.selectedMeetingDate = '';
    renderMeetingNotes();
  });
  $('#meeting-clear-date').addEventListener('click', () => {
    state.selectedMeetingDate = '';
    renderMeetingNotes();
  });
  $('#meeting-calendar-grid').addEventListener('click', (event) => {
    const day = event.target.closest('[data-meeting-date]');
    if (!day) return;
    state.selectedMeetingDate = state.selectedMeetingDate === day.dataset.meetingDate ? '' : day.dataset.meetingDate;
    renderMeetingNotes();
  });
  $('#meetings-go-today').addEventListener('click', () => setActiveView('today'));
  $('#meetings-starred-filter').addEventListener('click', () => {
    state.showStarredMeetingsOnly = !state.showStarredMeetingsOnly;
    renderMeetingNotes();
  });
  $('#meetings-list').addEventListener('click', async (event) => {
    const star = event.target.closest('[data-star-meeting]');
    if (star) {
      const relativePath = star.dataset.starMeeting;
      const note = state.meetingNotes.find((item) => item.relativePath === relativePath);
      if (!note) return;
      star.disabled = true;
      try {
        await window.daybook.setMeetingStarred(relativePath, !note.starred);
        state.meetingNotes = await window.daybook.listMeetingNotes();
        renderMeetingNotes();
      } catch (error) { star.disabled = false; showToast(`Meeting note: ${error.message}`, true); }
      return;
    }
    const button = event.target.closest('[data-open-meeting]');
    if (button) await openMeetingNote(button.dataset.openMeeting);
  });
  $('#people-add').addEventListener('click', openPersonModal);
  $('#people-empty [data-create-person]').addEventListener('click', openPersonModal);
  $('#people-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-open-person]');
    if (button) await openPersonDetail(button.dataset.openPerson);
  });
  $('#person-detail-back').addEventListener('click', () => { state.selectedPerson = null; $('#person-detail').classList.add('hidden'); $('#people-directory').classList.remove('hidden'); });
  $('#person-detail-open-note').addEventListener('click', async () => { if (state.selectedPerson) await window.daybook.openNote(state.selectedPerson.relativePath); });
  $('#person-association-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-filter]');
    if (!button) return;
    state.personAssociationFilter = button.dataset.personFilter;
    renderPersonAssociations();
  });
  $('#person-task-urgency-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-task-urgency]');
    if (!button) return;
    state.personTaskUrgencyFilter = button.dataset.personTaskUrgency;
    renderPersonAssociations();
  });
  $('#person-task-source-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-person-task-source]');
    if (!button) return;
    state.personTaskSourceFilter = button.dataset.personTaskSource;
    renderPersonAssociations();
  });
  $('#person-association-search').addEventListener('input', renderPersonAssociations);
  $('#person-detail').addEventListener('click', async (event) => {
    const meeting = event.target.closest('[data-person-open-meeting]');
    if (meeting) { await openMeetingNote(meeting.dataset.personOpenMeeting); return; }
    const note = event.target.closest('[data-person-open-note]');
    if (note) { await window.daybook.openNote(note.dataset.personOpenNote); return; }
    const task = event.target.closest('[data-person-open-task]');
    if (task) {
      if (task.dataset.personOpenTask === 'obsidian') await window.daybook.openNote(task.dataset.personTaskFile);
      else await window.daybook.openNativeTask(task.dataset.personOpenTask, task.dataset.personTaskId);
    }
  });
  $('#meeting-add-person').addEventListener('click', openPersonModal);
  $('#person-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Creating…';
    try {
      const result = await window.daybook.createPerson({ name: $('#person-name').value, role: $('#person-role').value, organization: $('#person-organization').value });
      $('#person-modal').classList.add('hidden');
      const selectedPeople = $$('#create-meeting-people input:checked').map((input) => input.value);
      if (!result.alreadyExisted) selectedPeople.push(result.relativePath);
      await loadPeople();
      renderMeetingPeopleChoices(selectedPeople);
      if (!result.alreadyExisted) showToast('Person note created in your People folder.');
      else showToast('That person is already in your People folder.');
    } catch (error) { $('#person-status').textContent = error.message; showToast(error.message, true); }
    finally { submit.disabled = false; submit.textContent = 'Create person'; }
  });
  ['#meeting-agenda-input', '#meeting-notes-input', '#meeting-action-items-input'].forEach((selector) => $(selector).addEventListener('input', scheduleMeetingNoteSave));
  $('#meeting-add-task').addEventListener('click', addMeetingActionTask);
  $('#meeting-editor-save').addEventListener('click', saveMeetingNote);
  $('#meeting-editor-back').addEventListener('click', async () => {
    await saveMeetingNote();
    if (!$('#meeting-editor-reload').classList.contains('hidden')) return;
    state.activeMeetingNote = null;
    renderMeetingNotes();
  });
  $('#meeting-editor-reload').addEventListener('click', () => {
    const path = state.activeMeetingNote?.relativePath;
    if (path) openMeetingNote(path, true);
  });
  $('#meeting-editor-open-obsidian').addEventListener('click', async () => {
    if (!state.activeMeetingNote) return;
    await saveMeetingNote();
    if ($('#meeting-editor-reload').classList.contains('hidden')) await window.daybook.openNote(state.activeMeetingNote.relativePath);
  });
  $('#meeting-editor').addEventListener('click', async (event) => {
    const note = event.target.closest('[data-one-on-one-note]');
    if (note) { await window.daybook.openNote(note.dataset.oneOnOneNote); return; }
    const task = event.target.closest('[data-one-on-one-task]');
    if (task) await window.daybook.openNativeTask(task.dataset.oneOnOneTask, task.dataset.oneOnOneTaskId);
  });
  $('#hevy-api-link').addEventListener('click', () => window.daybook.openHevyDeveloperSettings());
  $('#setup-vault').addEventListener('click', chooseVault);
  $('#change-vault').addEventListener('click', chooseVault);
  $('#prev-day').addEventListener('click', () => { const d = new Date(`${state.date}T12:00:00`); d.setDate(d.getDate() - 1); loadDate(localDateString(d)); });
  $('#next-day').addEventListener('click', () => { const d = new Date(`${state.date}T12:00:00`); d.setDate(d.getDate() + 1); loadDate(localDateString(d)); });
  $('#go-today').addEventListener('click', () => loadDate(localDateString(new Date())));
  $('#date-input').addEventListener('change', (event) => { if (event.target.value) loadDate(event.target.value); });
  $('#journal-prev-day').addEventListener('click', () => { const date = new Date(`${state.date}T12:00:00`); date.setDate(date.getDate() - 1); loadDate(localDateString(date)); });
  $('#journal-next-day').addEventListener('click', () => { const date = new Date(`${state.date}T12:00:00`); date.setDate(date.getDate() + 1); loadDate(localDateString(date)); });
  $('#journal-date-input').addEventListener('change', (event) => { if (event.target.value) loadDate(event.target.value); });
  $('#journal-go-today').addEventListener('click', () => loadDate(localDateString(new Date())));
  $('#open-note').addEventListener('click', async () => { if (state.notePath) await window.daybook.openNote(state.notePath); else showToast('Choose a vault first.', true); });
  $('#work-agenda-list').addEventListener('click', async (event) => {
    const createNoteButton = event.target.closest('[data-create-meeting]');
    if (createNoteButton) {
      const calendarEvent = state.calendarEvents[Number(createNoteButton.dataset.createMeeting)];
      if (!calendarEvent) return;
      createNoteButton.disabled = true;
      try {
        const result = await window.daybook.createMeetingNote(calendarEvent);
        await loadMeetingNotes();
        await openMeetingNote(result.relativePath);
        showToast(result.alreadyExisted ? 'Opened the existing meeting note.' : 'Meeting note created. Start taking notes here.');
      } catch (error) { showToast(error.message, true); }
      finally { createNoteButton.disabled = false; }
      return;
    }
    const action = event.target.closest('[data-calendar-action]')?.dataset.calendarAction;
    if (action === 'request') await requestCalendarAccess();
    if (action === 'retry') await refreshCalendarEvents();
    if (action === 'settings') {
      try { await window.daybook.openCalendarPrivacySettings(); }
      catch (error) { showToast(error.message, true); }
    }
  });
  $('#create-meeting-page').addEventListener('click', openCreateMeetingModal);
  $('#projects-add').addEventListener('click', () => openProjectEditor());
  $('#tasks-new-task').addEventListener('click', () => $('#task-create-choice-modal').classList.remove('hidden'));
  $('#task-create-choice-modal').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-create-task-source]');
    if (!choice) return;
    const source = choice.dataset.createTaskSource;
    $('#task-create-choice-modal').classList.add('hidden');
    if (source === 'todoist') openTodoistTaskComposer('');
    else openNativeTaskComposer(source);
  });
  $('#todoist-add-task').addEventListener('click', () => openTodoistTaskComposer(''));
  $('#obsidian-add-task').addEventListener('click', () => openNativeTaskComposer('obsidian'));
  $('#reminder-add-task').addEventListener('click', () => openNativeTaskComposer('reminder'));
  $('#native-task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $('#native-task-name').value.trim();
    if (!title) return;
    const dueDate = $('#native-task-date').value;
    const priority = Number($('#native-task-priority').value || 1);
    const save = $('#native-task-save');
    save.disabled = true;
    save.textContent = 'Adding…';
    try {
      if (state.activeTaskCreateSource === 'reminder') {
        await window.daybook.createReminder(title, dueDate, priority);
        await refreshReminders();
        showToast('Reminder added to Apple Reminders with its date and priority.');
      } else {
        await window.daybook.createObsidianTaskFromJournal(state.date, title, [], dueDate, priority);
        await refreshObsidianTasks();
        showToast('Task added to today’s Obsidian note with its date and priority.');
      }
      $('#native-task-modal').classList.add('hidden');
      $('#native-task-form').reset();
    } catch (error) {
      $('#native-task-status').textContent = error.message;
      showToast(error.message, true);
    } finally {
      save.disabled = false;
      save.textContent = state.activeTaskCreateSource === 'reminder' ? 'Add reminder' : 'Add task';
    }
  });
  $('#todoist-task-project').addEventListener('change', async (event) => {
    const sectionSelect = $('#todoist-task-section');
    sectionSelect.innerHTML = '<option value="">No section</option>';
    if (!event.target.value) return;
    try {
      const sections = await window.daybook.listTodoistSections(event.target.value);
      for (const section of sections) {
        const option = document.createElement('option');
        option.value = section.id;
        option.textContent = section.name;
        sectionSelect.append(option);
      }
    } catch (error) { $('#todoist-task-status').textContent = error.message; }
  });
  $('#todoist-task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const save = $('#todoist-task-save');
    const selectedProject = $('#todoist-task-project').value;
    const task = {
      content: $('#todoist-task-content').value,
      project_id: selectedProject,
      section_id: $('#todoist-task-section').value,
      priority: Number($('#todoist-task-priority').value),
      dueDate: $('#todoist-task-date').value,
      dueTime: $('#todoist-task-time').value,
      labels: $('#todoist-task-labels').value,
      description: $('#todoist-task-description').value
    };
    if (task.dueTime && !task.dueDate) {
      $('#todoist-task-status').textContent = 'Choose a due date before adding a due time.';
      return;
    }
    save.disabled = true;
    save.textContent = 'Adding…';
    $('#todoist-task-status').textContent = '';
    try {
      await window.daybook.createTask(task);
      $('#todoist-task-modal').classList.add('hidden');
      $('#todoist-task-form').reset();
      $('#todoist-task-section').innerHTML = '<option value="">No section</option>';
      await loadWork();
      showToast('Task added to Todoist. It appears in a list if it matches a saved filter.');
    } catch (error) {
      $('#todoist-task-status').textContent = error.message;
    } finally {
      save.disabled = false;
      save.textContent = 'Add task';
    }
  });
  $('#journal-input').addEventListener('input', updateJournalCount);
  $('#journal-add').addEventListener('click', addJournalEntry);
  $('#journal-entries').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-journal-task]');
    if (!button) return;
    const entry = state.day.journalEntries?.[Number(button.dataset.journalTask)];
    if (!entry) return;
    button.disabled = true;
    try {
      const result = await window.daybook.createObsidianTaskFromJournal(state.date, entry.text, entry.tags || []);
      button.textContent = '✓';
      button.title = result.created ? 'Obsidian task created' : 'Task already exists';
      button.setAttribute('aria-label', button.title);
      await loadWork();
      showToast(result.created ? 'Task added to the daily note.' : 'This task is already in the daily note.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message, true);
    }
  });
  $('#protocol-library-list').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-cycle-item], [data-cycle-timing], [data-cycle-frequency], [data-cycle-weekday]');
    if (!input) return;
    const relativePath = input.dataset.cycleItem || input.dataset.cycleTiming || input.dataset.cycleFrequency || input.dataset.cycleWeekday;
    const item = state.protocolItems.find((entry) => entry.relativePath === relativePath);
    const draft = state.protocolCycleDraft.get(relativePath) || {
      selected: false,
      timing: item?.timing || 'waking',
      frequency: normalizeProtocolFrequency(item?.frequency) || 'daily'
    };
    if (input.matches('[data-cycle-item]')) draft.selected = input.checked;
    if (input.matches('[data-cycle-timing]')) draft.timing = input.value;
    if (input.matches('[data-cycle-frequency]')) {
      draft.frequency = input.value === 'custom'
        ? (draft.frequency.startsWith('days:') ? draft.frequency : 'days:')
        : input.value;
    }
    if (input.matches('[data-cycle-weekday]')) {
      const selectedDays = new Set(draft.frequency.startsWith('days:') ? draft.frequency.slice(5).split(',').filter(Boolean) : []);
      if (input.checked) selectedDays.add(input.value);
      else selectedDays.delete(input.value);
      draft.frequency = `days:${PROTOCOL_DAYS.filter((day) => selectedDays.has(day.key)).map((day) => day.key).join(',')}`;
    }
    state.protocolCycleDraft.set(relativePath, draft);
    if (input.matches('[data-cycle-frequency]')) {
      renderProtocolLibrary();
      return;
    }
    const count = [...state.protocolCycleDraft.values()].filter((entry) => entry.selected).length;
    $('#protocol-library-count').textContent = `${count} selected`;
    $('#protocol-bundle-selection-count').textContent = `${count} ${count === 1 ? 'item' : 'items'} selected`;
    $('#protocol-cycle-bundle-save').disabled = false;
  });
  $('#protocol-library-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-open-library]');
    if (button) await window.daybook.openNote(button.dataset.openLibrary);
  });
  $('#protocol-library-search').addEventListener('input', renderProtocolLibrary);
  $('#protocol-library-category').addEventListener('change', renderProtocolLibrary);
  $('#protocol-cycle-bundle-name').addEventListener('input', () => {
    const count = [...state.protocolCycleDraft.values()].filter((entry) => entry.selected).length;
    $('#protocol-cycle-bundle-save').disabled = false;
  });
  $('#protocol-frequency').addEventListener('change', () => {
    $('#protocol-create-weekday-controls').classList.toggle('hidden', $('#protocol-frequency').value !== 'custom');
  });
  $('#hevy-refresh').addEventListener('click', async () => {
    $('#hevy-refresh').textContent = 'Loading history…';
    $('#hevy-refresh').disabled = true;
    await refreshHevyWorkouts();
    $('#hevy-refresh').textContent = 'Refresh ↻';
    $('#hevy-refresh').disabled = false;
  });
  $('#workout-period').addEventListener('change', renderWorkoutDashboard);
  $('#workout-week-prev').addEventListener('click', () => { state.workoutWeekOffset -= 1; renderWorkoutWeekCalendar(); });
  $('#workout-week-next').addEventListener('click', () => { state.workoutWeekOffset += 1; renderWorkoutWeekCalendar(); });
  $('#workout-week-today').addEventListener('click', () => { state.workoutWeekOffset = 0; renderWorkoutWeekCalendar(); });
  $('#workout-week-calendar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-plan-workout-date]');
    if (button) openWorkoutPlan(button.dataset.planWorkoutDate);
  });
  $('#workout-plan-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await saveWorkoutPlan(state.workoutPlanDate, $('#workout-plan-name').value);
      $('#workout-plan-modal').classList.add('hidden');
      showToast('Routine added to your weekly plan.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#workout-plan-clear').addEventListener('click', async () => {
    try {
      await saveWorkoutPlan(state.workoutPlanDate, '');
      $('#workout-plan-modal').classList.add('hidden');
      showToast('Routine removed from your plan.');
    } catch (error) { showToast(error.message, true); }
  });
  $('#workout-open-settings').addEventListener('click', openSettings);
  $('#work-category-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-work-quadrant]');
    if (!tab) return;
    state.activeQuadrant = tab.dataset.workQuadrant;
    renderTasks();
  });
  $('#todoist-task-list').addEventListener('click', (event) => {
    const projectToggle = event.target.closest('[data-toggle-todoist-project]');
    if (!projectToggle) return;
    const projectName = projectToggle.dataset.toggleTodoistProject;
    if (state.collapsedTodoistProjects.has(projectName)) state.collapsedTodoistProjects.delete(projectName);
    else state.collapsedTodoistProjects.add(projectName);
    renderTasks();
  });
  $('#work-view').addEventListener('click', (event) => {
    const removeTodayButton = event.target.closest('#due-today-list [data-remove-selected]');
    if (removeTodayButton) {
      removeSelectedWorkAt(Number(removeTodayButton.dataset.removeSelected));
      return;
    }
    const openButton = event.target.closest('[data-open-native-task]');
    if (openButton) {
      const source = openButton.dataset.openNativeTask;
      const action = source === 'obsidian'
        ? window.daybook.openNote(openButton.dataset.taskFile)
        : window.daybook.openNativeTask(source, openButton.dataset.taskId);
      action.catch((error) => showToast(error.message, true));
      return;
    }
    const editButton = event.target.closest('[data-edit-task-properties]');
    if (editButton) {
      const source = editButton.dataset.editTaskProperties;
      const task = source === 'todoist'
        ? Object.values(state.tasksByQuadrant).flat().find((item) => String(item.id) === editButton.dataset.taskId)
        : source === 'reminder'
          ? state.reminders.find((item) => String(item.id) === editButton.dataset.taskId)
          : state.obsidianTasks.find((item) => item.relativePath === editButton.dataset.taskFile && item.text === editButton.dataset.taskText);
      if (task) openTaskProperties(source, task);
      return;
    }
    const button = event.target.closest('[data-select-today]');
    if (!button) return;
    if (!state.config?.vaultPath) { showToast('Choose an Obsidian vault to save selections to the daily note.', true); return; }
    const source = button.dataset.selectSource;
    const task = source === 'todoist'
      ? Object.values(state.tasksByQuadrant).flat().find((item) => String(item.id) === button.dataset.selectId)
      : source === 'reminder'
        ? state.reminders.find((item) => String(item.id) === button.dataset.selectId)
        : state.obsidianTasks.find((item) => item.relativePath === button.dataset.selectFile && item.text === button.dataset.selectText);
    if (task) toggleWorkSelection(source, task);
  });
  $('#todoist-task-list').addEventListener('change', async (event) => {
    if (!event.target.matches('[data-task]')) return;
    const input = event.target; input.disabled = true;
    const task = Object.values(state.tasksByQuadrant).flat().find((item) => String(item.id) === input.dataset.task);
    try { await window.daybook.completeTask(input.dataset.task); if (task) removeWorkSelection('todoist', task); await loadWork(); showToast('Task completed in Todoist.'); }
    catch (error) { input.checked = false; showToast(error.message, true); }
  });
  $('#due-today-list').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-due-source]');
    if (!input) return;
    input.disabled = true;
    const source = input.dataset.dueSource;
    try {
      if (source === 'todoist') {
        const task = state.todoistDueToday.find((item) => String(item.id) === input.dataset.dueId)
          || Object.values(state.tasksByQuadrant).flat().find((item) => String(item.id) === input.dataset.dueId)
          || (state.day.selectedWork || []).find((item) => item.source === 'todoist' && String(item.id) === input.dataset.dueId);
        await window.daybook.completeTask(input.dataset.dueId);
        if (task) removeWorkSelection('todoist', task);
      } else if (source === 'obsidian') {
        const task = state.obsidianTasks.find((item) => item.relativePath === input.dataset.dueFile && item.text === input.dataset.dueText)
          || (state.day.selectedWork || []).find((item) => item.source === 'obsidian' && item.relativePath === input.dataset.dueFile && item.text === input.dataset.dueText);
        await window.daybook.completeObsidianTask(input.dataset.dueFile, task?.line ?? Number(input.dataset.dueLine), input.dataset.dueText);
        if (task) removeWorkSelection('obsidian', task);
      } else {
        const task = state.reminders.find((item) => String(item.id) === input.dataset.dueId)
          || (state.day.selectedWork || []).find((item) => item.source === 'reminder' && String(item.id) === input.dataset.dueId);
        await window.daybook.completeReminder(input.dataset.dueId);
        if (task) removeWorkSelection('reminder', task);
      }
      await loadWork();
      showToast(source === 'todoist' ? 'Task completed in Todoist.' : source === 'obsidian' ? 'Task checked off in its Obsidian note.' : 'Reminder completed in Apple Reminders.');
    } catch (error) {
      input.checked = false;
      input.disabled = false;
      if (source === 'obsidian') await loadWork();
      showToast(error.message, true);
    }
  });
  $('#work-agenda-list').addEventListener('change', async (event) => {
    const calendarInput = event.target.closest('[data-calendar-check]');
    if (calendarInput) {
      const calendarEvent = state.calendarEvents[Number(calendarInput.dataset.calendarCheck)];
      if (!calendarEvent) return;
      state.day.calendarChecks ||= {};
      const key = calendarEventKey(calendarEvent);
      if (calendarInput.checked) state.day.calendarChecks[key] = true;
      else delete state.day.calendarChecks[key];
      renderTodayPlan();
      scheduleSave();
      return;
    }
    const todoistInput = event.target.closest('[data-day-todoist]');
    const obsidianInput = event.target.closest('[data-day-obsidian-file]');
    const reminderInput = event.target.closest('[data-day-reminder]');
    if (!todoistInput && !obsidianInput && !reminderInput) return;
    const input = todoistInput || obsidianInput || reminderInput;
    input.disabled = true;
    try {
      if (todoistInput) {
        await window.daybook.completeTask(todoistInput.dataset.dayTodoist);
        const task = state.day.selectedWork.find((item) => item.source === 'todoist' && String(item.id) === todoistInput.dataset.dayTodoist);
        if (task) removeWorkSelection('todoist', task);
      } else if (obsidianInput) {
        const task = state.day.selectedWork.find((item) => item.source === 'obsidian' && item.relativePath === input.dataset.dayObsidianFile && item.text === input.dataset.dayObsidianText);
        const current = state.obsidianTasks.find((item) => item.relativePath === input.dataset.dayObsidianFile && item.text === input.dataset.dayObsidianText);
        await window.daybook.completeObsidianTask(input.dataset.dayObsidianFile, current?.line ?? Number(input.dataset.dayObsidianLine), input.dataset.dayObsidianText);
        if (task) removeWorkSelection('obsidian', task);
      } else {
        const task = state.day.selectedWork.find((item) => item.source === 'reminder' && String(item.id) === reminderInput.dataset.dayReminder);
        await window.daybook.completeReminder(input.dataset.dayReminder);
        if (task) removeWorkSelection('reminder', task);
      }
      await loadWork();
      showToast(todoistInput ? 'Task completed in Todoist.' : obsidianInput ? 'Task checked off in its Obsidian note.' : 'Reminder completed in Apple Reminders.');
    } catch (error) {
      input.checked = false;
      if (obsidianInput) await loadWork();
      showToast(error.message, true);
    }
  });
  $('#work-agenda-list').addEventListener('click', (event) => {
    const schedule = event.target.closest('[data-schedule-task]');
    if (schedule) { openTimeblockModal(Number(schedule.dataset.scheduleTask)); return; }
    const unschedule = event.target.closest('[data-unschedule-task]');
    if (unschedule) {
      const task = todayWorkTasks()[Number(unschedule.dataset.unscheduleTask)];
      if (task) { delete task.timeBlock; renderTodayPlan(); scheduleSave(); showToast('Task returned to Unscheduled.'); }
      return;
    }
    const remove = event.target.closest('[data-remove-selected]');
    if (remove) { removeSelectedWorkAt(Number(remove.dataset.removeSelected)); return; }
    const openNative = event.target.closest('[data-open-native-task]');
    if (openNative) {
      const source = openNative.dataset.openNativeTask;
      const action = source === 'obsidian'
        ? window.daybook.openNote(openNative.dataset.taskFile)
        : window.daybook.openNativeTask(source, openNative.dataset.taskId);
      action.catch((error) => showToast(error.message, true));
    }
  });

  $('#timeblock-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveTimeBlock(state.activeTimeblockIndex, $('#timeblock-start').value, $('#timeblock-duration').value);
  });

  const timeline = $('#day-timeline');
  timeline.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-protocol-bundle-complete]');
    if (!input) return;
    const cycleId = input.dataset.protocolCycleId;
    const bundleId = input.dataset.protocolBundleId;
    const scheduled = scheduledProtocolBundles(state.date).find((entry) => entry.cycle.id === cycleId && entry.bundle.id === bundleId);
    if (!scheduled) { renderTodayPlan(); return; }
    if (!scheduled.items.length) { renderTodayPlan(); return; }
    input.disabled = true;
    const target = input.checked;
    try {
      state.protocolCycles = await window.daybook.setProtocolCycleBundleCompletion(state.date, cycleId, bundleId, target);
      await window.daybook.commitProtocolCycleBundle(state.date, cycleId, bundleId);
      await refreshHabits();
      showToast(target ? `${scheduled.bundle.name} completed and added to today’s note.` : `${scheduled.bundle.name} updated in today’s note.`);
    } catch (error) {
      await refreshHabits();
      showToast(error.message, true);
    }
  });
  $('#work-agenda-list').addEventListener('dragstart', (event) => {
    const block = event.target.closest('[data-drag-task]');
    if (!block) return;
    const index = Number(block.dataset.dragTask);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    block.classList.add('is-dragging');
  });
  $('#work-agenda-list').addEventListener('dragend', (event) => event.target.closest('[data-drag-task]')?.classList.remove('is-dragging'));
  timeline.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; timeline.classList.add('drag-target'); });
  timeline.addEventListener('dragleave', (event) => { if (!timeline.contains(event.relatedTarget)) timeline.classList.remove('drag-target'); });
  timeline.addEventListener('drop', (event) => {
    event.preventDefault(); timeline.classList.remove('drag-target');
    const index = Number(event.dataTransfer.getData('text/plain'));
    if (!Number.isInteger(index) || !todayWorkTasks()[index]) return;
    const rect = timeline.getBoundingClientRect();
    const y = event.clientY - rect.top + timeline.scrollTop;
    const rawMinutes = DAY_START_MINUTES + y / TIMELINE_HOUR_HEIGHT * 60;
    const start = Math.max(DAY_START_MINUTES, Math.min(DAY_END_MINUTES - 30, Math.round(rawMinutes / 30) * 30));
    const duration = Number(todayWorkTasks()[index].timeBlock?.duration || 30);
    if (!saveTimeBlock(index, minutesToTimeString(start), duration)) showToast($('#timeblock-status').textContent || 'Could not place this task there.', true);
  });
  $('#obsidian-task-list').addEventListener('change', async (event) => {
    if (!event.target.matches('[data-obsidian-file]')) return;
    const input = event.target; input.disabled = true;
    try {
      await window.daybook.completeObsidianTask(input.dataset.obsidianFile, Number(input.dataset.obsidianLine), input.dataset.obsidianText);
      const task = state.obsidianTasks.find((item) => item.relativePath === input.dataset.obsidianFile && item.text === input.dataset.obsidianText);
      if (task) removeWorkSelection('obsidian', task);
      await refreshObsidianTasks();
      showToast('Task checked off in its Obsidian note.');
    } catch (error) {
      input.checked = false;
      await refreshObsidianTasks();
      showToast(error.message, true);
    }
  });
  $('#obsidian-task-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-open-file]');
    if (button) await window.daybook.openNote(button.dataset.openFile);
  });
  $('#reminder-task-list').addEventListener('change', async (event) => {
    if (!event.target.matches('[data-reminder]')) return;
    const input = event.target;
    input.disabled = true;
    try {
      await window.daybook.completeReminder(input.dataset.reminder);
      const reminder = state.reminders.find((item) => String(item.id) === input.dataset.reminder);
      if (reminder) removeWorkSelection('reminder', reminder);
      await refreshReminders();
      showToast('Reminder completed in Apple Reminders.');
    } catch (error) { input.checked = false; showToast(error.message, true); }
  });
  $('#matrix-refresh').addEventListener('click', loadWork);
  $('#due-today-refresh').addEventListener('click', loadWork);
  $('#agenda-refresh').addEventListener('click', () => Promise.all([loadWork(), state.config.calendarEnabled ? refreshCalendarEvents() : Promise.resolve()]));
  $('#obsidian-refresh').addEventListener('click', refreshObsidianTasks);
  $('#reminders-refresh').addEventListener('click', refreshReminders);
  $('#connect-todoist').addEventListener('click', openSettings);
  const openCycleBundleEditor = async (bundle = null) => {
    const cycle = state.protocolCycles.find((item) => item.id === state.selectedProtocolCycle);
    if (!cycle) { showToast('Create or choose a protocol cycle first.', true); return; }
    await refreshHabits();
    state.protocolCycleDraft = new Map((bundle?.items || []).map((item) => [item.relativePath, { selected: true, timing: item.timing || 'waking', frequency: normalizeProtocolFrequency(item.frequency) || 'daily' }]));
    state.editingProtocolBundleId = bundle?.id || '';
    state.protocolCycleBundleTime = bundle?.time || '08:00';
    $('#protocol-cycle-bundle-name').value = bundle?.name || '';
    $('#protocol-cycle-bundle-time').value = state.protocolCycleBundleTime;
    $('#protocol-library-search').value = '';
    $('#protocol-library-category').value = '';
    renderProtocolLibrary();
    $('#protocol-library-modal').classList.remove('hidden');
    if (!bundle) $('#protocol-cycle-bundle-name').focus();
  };
  const beginProtocolCycle = (cycle = null) => {
    const now = new Date(`${state.date}T12:00:00`);
    const month = state.date.slice(0, 7);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    state.editingProtocolCycleId = cycle?.id || null;
    $('#protocol-cycle-panel').open = true;
    $('#protocol-cycle-name').value = cycle?.name || `Cycle ${month}`;
    $('#protocol-cycle-start').value = cycle?.startDate || `${month}-01`;
    $('#protocol-cycle-end').value = cycle?.endDate || `${month}-${String(lastDay).padStart(2, '0')}`;
    $('#protocol-cycle-form [type="submit"]').textContent = cycle ? 'Save changes' : 'Save cycle';
    $('#protocol-cycle-form').classList.remove('hidden');
    $('#protocol-cycle-name').focus();
  };
  $('#build-protocol').addEventListener('click', () => beginProtocolCycle());
  $('#protocol-cycle-cancel').addEventListener('click', () => {
    state.editingProtocolCycleId = null;
    $('#protocol-cycle-form').classList.add('hidden');
  });
  $('#protocol-cycle-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || $('#protocol-cycle-form [type="submit"]');
    button.disabled = true;
    try {
      const editingId = state.editingProtocolCycleId;
      state.protocolCycles = await window.daybook.saveProtocolCycle({
        id: editingId || undefined,
        name: $('#protocol-cycle-name').value,
        startDate: $('#protocol-cycle-start').value,
        endDate: $('#protocol-cycle-end').value
      });
      state.selectedProtocolCycle = editingId || state.protocolCycles.at(-1)?.id || state.selectedProtocolCycle;
      state.editingProtocolCycleId = null;
      $('#protocol-cycle-form').classList.add('hidden');
      renderProtocolCycles();
      showToast(editingId ? 'Protocol cycle updated.' : 'Protocol cycle saved.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#protocol-cycle-select').addEventListener('change', (event) => {
    state.selectedProtocolCycle = event.target.value;
    renderProtocolCycles();
  });
  $('#protocol-cycle-add-bundle').addEventListener('click', () => openCycleBundleEditor());
  $('#protocol-cycle-bundles').addEventListener('click', async (event) => {
    if (event.target.closest('[data-create-cycle-bundle]')) { await openCycleBundleEditor(); return; }
    const edit = event.target.closest('[data-edit-cycle-bundle]');
    if (edit) {
      const cycle = state.protocolCycles.find((item) => item.id === state.selectedProtocolCycle);
      const bundle = cycle?.bundles.find((item) => item.id === edit.dataset.editCycleBundle);
      if (bundle) await openCycleBundleEditor(bundle);
      return;
    }
  });
  $('#protocol-cycle-summary').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-protocol-cycle]');
    if (!button) return;
    const cycle = state.protocolCycles.find((item) => item.id === button.dataset.editProtocolCycle);
    if (cycle) beginProtocolCycle(cycle);
  });
  $('#new-protocol-item').addEventListener('click', () => {
    $('#protocol-name').value = '';
    $('#protocol-description').value = '';
    $('#protocol-category').value = 'supplement';
    $('#protocol-timing').value = 'waking';
    $('#protocol-frequency').value = 'daily';
    $('#protocol-create-weekday-controls').classList.add('hidden');
    $$('[data-protocol-weekday]').forEach((input) => { input.checked = false; });
    $('#protocol-library-modal').classList.add('hidden');
    $('#protocol-modal').classList.remove('hidden');
    $('#protocol-name').focus();
  });
  $('.close-library').addEventListener('click', () => $('#protocol-library-modal').classList.add('hidden'));
  $('#protocol-bundle-select').addEventListener('change', (event) => {
    state.selectedProtocolBundle = event.target.value;
    renderProtocolBundles();
  });
  $('#protocol-cycle-bundle-save').addEventListener('click', async () => {
    syncCycleBundleSelectionsFromEditor();
    const selections = [...state.protocolCycleDraft.entries()]
      .filter(([, draft]) => draft.selected)
      .map(([relativePath, draft]) => ({ relativePath, timing: draft.timing, frequency: draft.frequency }));
    const button = $('#protocol-cycle-bundle-save');
    const name = $('#protocol-cycle-bundle-name').value.trim();
    if (!name) { showToast('Enter a name for this bundle.', true); $('#protocol-cycle-bundle-name').focus(); return; }
    if (!selections.length) { showToast('Select at least one Wellness item for this bundle.', true); return; }
    if (selections.some((item) => item.frequency === 'days:')) { showToast('Choose at least one weekday for each selected item.', true); return; }
    if (!state.selectedProtocolCycle) { showToast('Choose a protocol cycle first.', true); return; }
    button.disabled = true;
    try {
      state.protocolCycles = await window.daybook.saveProtocolCycleBundle(state.selectedProtocolCycle, $('#protocol-cycle-bundle-name').value, selections, state.editingProtocolBundleId, $('#protocol-cycle-bundle-time').value);
      state.editingProtocolBundleId = '';
      $('#protocol-library-modal').classList.add('hidden');
      renderProtocolCycles();
      showToast('Bundle saved in this cycle.');
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#protocol-bundle-commit').addEventListener('click', async () => {
    const button = $('#protocol-bundle-commit');
    button.disabled = true;
    try {
      const result = await window.daybook.commitProtocolBundle(state.date, state.selectedProtocolBundle);
      await refreshHabits();
      showToast(`${result.name} added to ${result.relativePath}.`);
    } catch (error) { showToast(error.message, true); }
    finally { renderProtocolBundles(); }
  });
  const previewAppearance = () => applyAppearance({ mode: $('#appearance-mode').value, color: $('#appearance-color').value });
  $('#appearance-mode').addEventListener('change', previewAppearance);
  $('#appearance-color').addEventListener('change', previewAppearance);
  $$('.close-modal').forEach((button) => button.addEventListener('click', () => {
    const modal = button.closest('.modal-backdrop');
    modal.classList.add('hidden');
    if (modal.id === 'project-editor-modal') state.editingProject = null;
    if (modal.id === 'settings-modal') applyAppearance();
  }));
  $$('.modal-backdrop').forEach((modal) => modal.addEventListener('click', (event) => {
    if (event.target !== modal) return;
    modal.classList.add('hidden');
    if (modal.id === 'project-editor-modal') state.editingProject = null;
    if (modal.id === 'settings-modal') applyAppearance();
  }));
  $('#protocol-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      let frequency = $('#protocol-frequency').value;
      if (frequency === 'custom') {
        const selectedDays = $$('[data-protocol-weekday]:checked').map((input) => input.dataset.protocolWeekday);
        if (!selectedDays.length) { showToast('Choose at least one weekday.', true); return; }
        frequency = `days:${PROTOCOL_DAYS.filter((day) => selectedDays.includes(day.key)).map((day) => day.key).join(',')}`;
      }
      await window.daybook.createProtocolItem($('#protocol-name').value, $('#protocol-category').value, $('#protocol-timing').value, frequency, $('#protocol-description').value, state.date);
      $('#protocol-modal').classList.add('hidden');
      await refreshHabits();
      renderProtocolLibrary();
      $('#protocol-library-modal').classList.remove('hidden');
      showToast('Saved to Wellness. Add it to a bundle and commit the bundle to make it active.');
    } catch (error) { showToast(error.message, true); }
  });
  $('#servicenow-auth-type').addEventListener('change', updateServiceNowAuthFields);
  $('#save-settings').addEventListener('click', async () => {
    try {
      state.config = await window.daybook.saveConfig({
        dailyFolder: $('#daily-folder-setting').value.trim() || 'Daily',
        attachmentsFolder: $('#attachments-folder-setting').value.trim() || 'Attachments',
        habitsFolder: $('#habits-folder-setting').value.trim() || 'Habits',
        wellnessFolder: $('#wellness-folder-setting').value.trim() || 'Wellness',
        projectsFolder: $('#projects-folder-setting').value.trim() || 'PROJECTS',
        meetingsFolder: $('#meetings-folder-setting').value.trim() || 'MEETINGS',
        peopleFolder: $('#people-folder-setting').value.trim() || 'People',
        todoistToken: $('#todoist-token').value.trim(),
        hevyApiKey: $('#hevy-api-key').value.trim(),
        wrikeHost: $('#wrike-host').value.trim() || 'https://www.wrike.com',
        wrikeToken: $('#wrike-token').value.trim(),
        serviceNowInstance: $('#servicenow-instance').value.trim(),
        serviceNowUser: $('#servicenow-user').value.trim(),
        serviceNowAuthType: $('#servicenow-auth-type').value,
        serviceNowToken: $('#servicenow-token').value.trim(),
        serviceNowPassword: $('#servicenow-password').value,
        modules: {
          habits: $('#module-habits').checked,
          wellness: $('#module-wellness').checked,
          todoist: $('#module-todoist').checked,
          wrike: $('#module-wrike').checked,
          serviceNow: $('#module-serviceNow').checked,
          hevy: $('#module-hevy').checked
        },
        appearance: {
          mode: $('#appearance-mode').value,
          color: $('#appearance-color').value
        }
      });
      applyAppearance();
      applyModuleVisibility();
      renderTaskSourceTabs();
      state.hevyLoaded = false;
      if (state.activeView === 'workouts' && state.config.modules.hevy) await refreshHevyWorkouts();
      $('#settings-modal').classList.add('hidden');
      updateVaultLabel();
      if (state.config.modules.habits || state.config.modules.wellness) await refreshHabits();
      await loadDate(state.date);
      await loadWork();
      await loadMeetingNotes();
      await loadProjects();
      showToast('Settings saved.');
    } catch (error) { $('#settings-status').textContent = error.message; }
  });
}

init().catch((error) => showToast(error.message || 'Daybook could not start.', true));
