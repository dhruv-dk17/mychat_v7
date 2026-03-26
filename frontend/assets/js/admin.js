'use strict';

const adminState = {
  secret: '',
  summary: null,
  users: {
    page: 1,
    limit: 15,
    query: '',
    sort: 'recent',
    filter: 'all',
    total: 0,
    pages: 0,
    items: [],
    targetOptions: [],
  },
  broadcasts: {
    page: 1,
    limit: 6,
    total: 0,
    pages: 0,
    items: [],
  },
  confirm: {
    onConfirm: null,
    requiredText: '',
  },
};

const refs = {};
let toastTimer = null;
let searchTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  captureRefs();
  bindEvents();
  syncFormDefaults();
});

function captureRefs() {
  refs.authMask = document.getElementById('auth-mask');
  refs.appContainer = document.getElementById('app-container');
  refs.authForm = document.getElementById('auth-form');
  refs.secretInput = document.getElementById('secret-input');
  refs.authSubmit = document.getElementById('auth-submit');
  refs.authError = document.getElementById('auth-error');
  refs.refreshButton = document.getElementById('refresh-button');
  refs.logoutButton = document.getElementById('logout-button');
  refs.toast = document.getElementById('toast');
  refs.lastRefresh = document.getElementById('last-refresh');

  refs.summaryUsers = document.getElementById('summary-users');
  refs.summaryRooms = document.getElementById('summary-rooms');
  refs.summaryBroadcasts = document.getElementById('summary-broadcasts');
  refs.summaryCleanup = document.getElementById('summary-cleanup');

  refs.userSearch = document.getElementById('user-search');
  refs.userSort = document.getElementById('user-sort');
  refs.userPageSize = document.getElementById('user-page-size');
  refs.userFilterChips = Array.from(document.querySelectorAll('[data-user-filter]'));
  refs.usersCountNote = document.getElementById('users-count-note');
  refs.usersTableBody = document.getElementById('users-table-body');
  refs.usersPagination = document.getElementById('users-pagination');

  refs.broadcastForm = document.getElementById('broadcast-form');
  refs.broadcastTarget = document.getElementById('bc-target');
  refs.broadcastContent = document.getElementById('bc-content');
  refs.broadcastSendButton = document.getElementById('bc-send-button');
  refs.broadcastsCountNote = document.getElementById('broadcasts-count-note');
  refs.broadcastsList = document.getElementById('broadcasts-list');
  refs.broadcastsPagination = document.getElementById('broadcasts-pagination');

  refs.confirmModal = document.getElementById('confirm-modal');
  refs.confirmTitle = document.getElementById('confirm-title');
  refs.confirmBody = document.getElementById('confirm-body');
  refs.confirmDetail = document.getElementById('confirm-detail');
  refs.confirmFieldWrap = document.getElementById('confirm-field-wrap');
  refs.confirmFieldLabel = document.getElementById('confirm-field-label');
  refs.confirmField = document.getElementById('confirm-field');
  refs.confirmFieldError = document.getElementById('confirm-field-error');
  refs.confirmClose = document.getElementById('confirm-close');
  refs.confirmCancel = document.getElementById('confirm-cancel');
  refs.confirmSubmit = document.getElementById('confirm-submit');
}

function bindEvents() {
  refs.authForm?.addEventListener('submit', handleAuthSubmit);
  refs.refreshButton?.addEventListener('click', () => {
    refreshDashboard(true).catch(handleDashboardError);
  });
  refs.logoutButton?.addEventListener('click', logoutAdmin);

  refs.userSearch?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      adminState.users.query = refs.userSearch.value.trim();
      adminState.users.page = 1;
      loadUsers(true).catch(handleDashboardError);
    }, 220);
  });

  refs.userSort?.addEventListener('change', () => {
    adminState.users.sort = refs.userSort.value;
    renderUsers();
  });

  refs.userPageSize?.addEventListener('change', () => {
    adminState.users.limit = parseInt(refs.userPageSize.value, 10) || 15;
    adminState.users.page = 1;
    loadUsers(true).catch(handleDashboardError);
  });

  refs.userFilterChips.forEach((button) => {
    button.addEventListener('click', () => {
      adminState.users.filter = button.dataset.userFilter || 'all';
      adminState.users.page = 1;
      refs.userFilterChips.forEach((chip) => chip.classList.toggle('active', chip === button));
      renderUsers();
    });
  });

  refs.broadcastForm?.addEventListener('submit', handleBroadcastSubmit);

  refs.confirmClose?.addEventListener('click', closeConfirmModal);
  refs.confirmCancel?.addEventListener('click', closeConfirmModal);
  refs.confirmSubmit?.addEventListener('click', handleConfirmSubmit);
  refs.confirmModal?.addEventListener('click', (event) => {
    if (event.target === refs.confirmModal) {
      closeConfirmModal();
    }
  });
}

function syncFormDefaults() {
  adminState.users.limit = parseInt(refs.userPageSize?.value, 10) || adminState.users.limit;
  adminState.users.sort = refs.userSort?.value || adminState.users.sort;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const secret = refs.secretInput?.value.trim();
  if (!secret) {
    setAuthError('Enter the admin secret to continue.');
    refs.secretInput?.focus();
    return;
  }

  setAuthLoading(true);
  setAuthError('');
  adminState.secret = secret;

  try {
    await refreshDashboard(false);
    refs.authMask.hidden = true;
    refs.appContainer.hidden = false;
    refs.secretInput.value = '';
    showToast('Dashboard connected.', 'success');
  } catch (error) {
    adminState.secret = '';
    setAuthError(error.message || 'Authentication failed.');
    showToast(error.message || 'Authentication failed.', 'error');
  } finally {
    setAuthLoading(false);
  }
}

function logoutAdmin() {
  adminState.secret = '';
  refs.appContainer.hidden = true;
  refs.authMask.hidden = false;
  refs.authError.textContent = '';
  refs.secretInput.value = '';
  refs.secretInput.focus();
}

async function refreshDashboard(showRefreshToast) {
  await Promise.all([
    loadSummary(),
    loadUsers(false),
    loadBroadcasts(false),
    loadBroadcastTargets(),
  ]);

  const now = new Date();
  refs.lastRefresh.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (showRefreshToast) {
    showToast('Dashboard refreshed.', 'success');
  }
}

async function fetchAdmin(path, options = {}) {
  const response = await fetch(`${CONFIG.API_BASE}/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Secret': adminState.secret,
      ...(options.headers || {}),
    },
  });

  let data = {};
  try {
    data = await response.json();
  } catch (error) {}

  if (response.status === 401) {
    throw new Error('Your admin session is no longer valid.');
  }
  if (!response.ok) {
    throw new Error(data.error || 'Admin request failed.');
  }

  return data;
}

async function loadSummary() {
  const data = await fetchAdmin('/summary');
  adminState.summary = data;
  refs.summaryUsers.textContent = formatNumber(data.active_users);
  refs.summaryRooms.textContent = formatNumber(data.total_rooms);
  refs.summaryBroadcasts.textContent = formatNumber(data.total_broadcasts);
  refs.summaryCleanup.textContent = formatNumber(data.deleted_users);
}

async function loadUsers(renderLoadingState) {
  if (renderLoadingState) {
    renderUsersLoading();
  }

  const { page, limit, query } = adminState.users;
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (query) {
    params.set('query', query);
  }

  const data = await fetchAdmin(`/users?${params.toString()}`);
  adminState.users.total = data.total || 0;
  adminState.users.pages = data.pages || 0;
  adminState.users.items = Array.isArray(data.users) ? data.users : [];
  renderUsers();
}

async function loadBroadcastTargets() {
  const data = await fetchAdmin('/users?page=1&limit=100');
  adminState.users.targetOptions = Array.isArray(data.users) ? data.users : [];
  renderBroadcastTargets();
}

async function loadBroadcasts(renderLoadingState) {
  if (renderLoadingState) {
    renderBroadcastsLoading();
  }

  const params = new URLSearchParams({
    page: String(adminState.broadcasts.page),
    limit: String(adminState.broadcasts.limit),
  });

  const data = await fetchAdmin(`/broadcasts?${params.toString()}`);
  adminState.broadcasts.total = data.total || 0;
  adminState.broadcasts.pages = data.pages || 0;
  adminState.broadcasts.items = Array.isArray(data.broadcasts) ? data.broadcasts : [];
  renderBroadcasts();
}

function renderUsersLoading() {
  refs.usersTableBody.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const row = document.createElement('tr');
    for (let cellIndex = 0; cellIndex < 4; cellIndex += 1) {
      const cell = document.createElement('td');
      const skeleton = document.createElement('div');
      skeleton.className = 'skeleton skeleton-line';
      cell.appendChild(skeleton);
      row.appendChild(cell);
    }
    refs.usersTableBody.appendChild(row);
  }
  refs.usersCountNote.textContent = 'Loading users';
}

function renderUsers() {
  refs.usersTableBody.replaceChildren();
  const filteredUsers = applyUserFilter(sortUsers([...adminState.users.items]));
  refs.usersCountNote.textContent = buildUsersCountNote(filteredUsers.length);

  if (filteredUsers.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    const empty = buildEmptyState('No users found', 'Try a broader search or switch back to all users.');
    cell.appendChild(empty);
    row.appendChild(cell);
    refs.usersTableBody.appendChild(row);
  } else {
    filteredUsers.forEach((user) => refs.usersTableBody.appendChild(buildUserRow(user)));
  }

  renderPagination({
    container: refs.usersPagination,
    page: adminState.users.page,
    pages: adminState.users.pages,
    total: adminState.users.total,
    itemLabel: 'users',
    onPageChange(nextPage) {
      adminState.users.page = nextPage;
      loadUsers(true).catch(handleDashboardError);
    },
  });
}

function buildUserRow(user) {
  const row = document.createElement('tr');

  const idCell = document.createElement('td');
  const idBadge = document.createElement('span');
  idBadge.className = 'uid-badge mono';
  idBadge.textContent = user.uid || `u${user.internal_id}`;
  idCell.appendChild(idBadge);
  const note = document.createElement('div');
  note.className = 'row-note';
  note.textContent = user.username || 'Anonymous';
  idCell.appendChild(note);

  const dateCell = document.createElement('td');
  const dateBadge = document.createElement('span');
  dateBadge.className = 'date-badge';
  dateBadge.textContent = formatDate(user.joined_at || user.created_at);
  dateCell.appendChild(dateBadge);

  const roomCell = document.createElement('td');
  const roomBadge = document.createElement('span');
  roomBadge.className = 'count-badge mono';
  roomBadge.textContent = `${user.room_count || 0} rooms`;
  roomCell.appendChild(roomBadge);

  const actionCell = document.createElement('td');
  actionCell.className = 'align-right';
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-sm btn-danger';
  deleteButton.textContent = 'Delete user';
  deleteButton.addEventListener('click', () => {
    openConfirmModal({
      title: 'Delete user',
      body: `Delete ${user.uid} and all permanent rooms they own?`,
      detail: `${user.username || 'Unknown user'} joined ${formatDate(user.joined_at || user.created_at)}.`,
      submitLabel: 'Delete user',
      requiredText: user.uid,
      fieldLabel: `Type ${user.uid} to confirm`,
      onConfirm: async () => {
        await fetchAdmin(`/users/${encodeURIComponent(user.uid)}`, { method: 'DELETE' });
        showToast(`${user.uid} deleted.`, 'success');
        await Promise.all([loadSummary(), loadUsers(false), loadBroadcastTargets()]);
      },
    });
  });
  actions.appendChild(deleteButton);
  actionCell.appendChild(actions);

  row.append(idCell, dateCell, roomCell, actionCell);
  return row;
}

function renderBroadcastTargets() {
  const currentValue = refs.broadcastTarget.value;
  refs.broadcastTarget.replaceChildren();

  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All active users';
  refs.broadcastTarget.appendChild(allOption);

  adminState.users.targetOptions
    .filter((user) => user && user.uid)
    .forEach((user) => {
      const option = document.createElement('option');
      option.value = user.uid;
      option.textContent = `${user.uid} - ${user.username || 'Unknown user'}`;
      refs.broadcastTarget.appendChild(option);
    });

  refs.broadcastTarget.value = Array.from(refs.broadcastTarget.options).some((option) => option.value === currentValue)
    ? currentValue
    : '';
}

function renderBroadcastsLoading() {
  refs.broadcastsList.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const block = document.createElement('div');
    block.className = 'broadcast-card skeleton skeleton-block';
    refs.broadcastsList.appendChild(block);
  }
  refs.broadcastsCountNote.textContent = 'Loading broadcasts';
}

function renderBroadcasts() {
  refs.broadcastsList.replaceChildren();
  refs.broadcastsCountNote.textContent = `${formatNumber(adminState.broadcasts.total)} total broadcasts`;

  if (!adminState.broadcasts.items.length) {
    refs.broadcastsList.appendChild(buildEmptyState('No broadcasts yet', 'Use the composer to send the first platform notice.'));
  } else {
    adminState.broadcasts.items.forEach((broadcast) => {
      refs.broadcastsList.appendChild(buildBroadcastCard(broadcast));
    });
  }

  renderPagination({
    container: refs.broadcastsPagination,
    page: adminState.broadcasts.page,
    pages: adminState.broadcasts.pages,
    total: adminState.broadcasts.total,
    itemLabel: 'broadcasts',
    onPageChange(nextPage) {
      adminState.broadcasts.page = nextPage;
      loadBroadcasts(true).catch(handleDashboardError);
    },
  });
}

function buildBroadcastCard(broadcast) {
  const card = document.createElement('article');
  card.className = 'broadcast-card';

  const top = document.createElement('div');
  top.className = 'broadcast-top';

  const meta = document.createElement('div');
  meta.className = 'broadcast-meta';
  meta.appendChild(buildBadge('target-badge mono', broadcast.target || 'All users'));
  meta.appendChild(buildBadge('date-badge', formatDateTime(broadcast.created_at)));
  if (broadcast.expires_at) {
    meta.appendChild(buildBadge('status-badge warn', `Expires ${formatDateTime(broadcast.expires_at)}`));
  }

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'btn btn-sm btn-danger';
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => {
    openConfirmModal({
      title: 'Delete broadcast',
      body: 'Remove this broadcast from the dashboard?',
      detail: broadcast.content,
      submitLabel: 'Delete broadcast',
      onConfirm: async () => {
        await fetchAdmin(`/broadcasts/${broadcast.id}`, { method: 'DELETE' });
        showToast('Broadcast deleted.', 'success');
        await Promise.all([loadSummary(), loadBroadcasts(false)]);
      },
    });
  });

  top.append(meta, deleteButton);

  const content = document.createElement('div');
  content.className = 'broadcast-content';
  content.textContent = broadcast.content;

  card.append(top, content);
  return card;
}

async function handleBroadcastSubmit(event) {
  event.preventDefault();
  const content = refs.broadcastContent.value.trim();
  if (!content) {
    showToast('Write a message before dispatching.', 'warning');
    refs.broadcastContent.focus();
    return;
  }

  refs.broadcastSendButton.disabled = true;
  refs.broadcastSendButton.textContent = 'Sending...';

  try {
    await fetchAdmin('/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        target_uid: refs.broadcastTarget.value || null,
        content,
      }),
    });
    refs.broadcastContent.value = '';
    refs.broadcastTarget.value = '';
    showToast('Broadcast dispatched.', 'success');
    await Promise.all([loadSummary(), loadBroadcasts(false)]);
  } catch (error) {
    handleDashboardError(error);
  } finally {
    refs.broadcastSendButton.disabled = false;
    refs.broadcastSendButton.textContent = 'Dispatch broadcast';
  }
}

function openConfirmModal({ title, body, detail = '', submitLabel = 'Confirm', requiredText = '', fieldLabel = 'Type to confirm', onConfirm }) {
  adminState.confirm.onConfirm = onConfirm;
  adminState.confirm.requiredText = requiredText || '';

  refs.confirmTitle.textContent = title;
  refs.confirmBody.textContent = body;
  refs.confirmDetail.textContent = detail;
  refs.confirmSubmit.textContent = submitLabel;
  refs.confirmFieldLabel.textContent = fieldLabel;
  refs.confirmField.value = '';
  refs.confirmFieldError.textContent = '';
  refs.confirmFieldWrap.hidden = !requiredText;
  refs.confirmModal.hidden = false;

  if (requiredText) {
    refs.confirmField.focus();
  } else {
    refs.confirmSubmit.focus();
  }
}

function closeConfirmModal() {
  refs.confirmModal.hidden = true;
  adminState.confirm.onConfirm = null;
  adminState.confirm.requiredText = '';
  refs.confirmFieldError.textContent = '';
  refs.confirmField.value = '';
}

async function handleConfirmSubmit() {
  if (adminState.confirm.requiredText) {
    if (refs.confirmField.value.trim() !== adminState.confirm.requiredText) {
      refs.confirmFieldError.textContent = `Enter ${adminState.confirm.requiredText} to continue.`;
      refs.confirmField.focus();
      return;
    }
  }

  if (typeof adminState.confirm.onConfirm !== 'function') {
    closeConfirmModal();
    return;
  }

  refs.confirmSubmit.disabled = true;
  try {
    await adminState.confirm.onConfirm();
    closeConfirmModal();
  } catch (error) {
    handleDashboardError(error);
  } finally {
    refs.confirmSubmit.disabled = false;
  }
}

function renderPagination({ container, page, pages, total, itemLabel, onPageChange }) {
  container.replaceChildren();
  if (!pages) {
    const copy = document.createElement('div');
    copy.className = 'pagination-copy';
    copy.textContent = total ? `${formatNumber(total)} ${itemLabel}` : `0 ${itemLabel}`;
    container.appendChild(copy);
    return;
  }

  const copy = document.createElement('div');
  copy.className = 'pagination-copy';
  copy.textContent = `Page ${page} of ${pages} - ${formatNumber(total)} ${itemLabel}`;

  const actions = document.createElement('div');
  actions.className = 'pagination-group';
  actions.appendChild(buildPageButton('Previous', page <= 1, () => onPageChange(page - 1)));
  actions.appendChild(buildPageButton('Next', page >= pages, () => onPageChange(page + 1)));

  container.append(copy, actions);
}

function buildPageButton(label, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-ghost btn-sm';
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function sortUsers(users) {
  switch (adminState.users.sort) {
    case 'rooms':
      return users.sort((left, right) => (right.room_count || 0) - (left.room_count || 0) || (right.internal_id || 0) - (left.internal_id || 0));
    case 'id':
      return users.sort((left, right) => (left.internal_id || 0) - (right.internal_id || 0));
    case 'recent':
    default:
      return users.sort((left, right) => (right.created_at || right.joined_at || 0) - (left.created_at || left.joined_at || 0));
  }
}

function applyUserFilter(users) {
  switch (adminState.users.filter) {
    case 'with-rooms':
      return users.filter((user) => Number(user.room_count || 0) > 0);
    case 'without-rooms':
      return users.filter((user) => Number(user.room_count || 0) === 0);
    default:
      return users;
  }
}

function buildUsersCountNote(visibleCount) {
  if (!adminState.users.total) {
    return 'No users found';
  }
  if (visibleCount === adminState.users.total) {
    return `${formatNumber(adminState.users.total)} users available`;
  }
  return `${formatNumber(visibleCount)} shown on this page · ${formatNumber(adminState.users.total)} total`;
}

function buildBadge(className, text) {
  const badge = document.createElement('span');
  badge.className = className;
  badge.textContent = text;
  return badge;
}

function buildEmptyState(title, copy) {
  const empty = document.createElement('div');
  empty.className = 'panel-empty';

  const heading = document.createElement('div');
  heading.className = 'empty-title';
  heading.textContent = title;

  const body = document.createElement('div');
  body.className = 'empty-copy';
  body.textContent = copy;

  empty.append(heading, body);
  return empty;
}

function handleDashboardError(error) {
  if (error?.message === 'Your admin session is no longer valid.') {
    logoutAdmin();
    setAuthError('Your admin session expired. Authenticate again.');
    showToast('Admin session expired.', 'warning');
    return;
  }
  showToast(error?.message || 'Something went wrong.', 'error');
}

function setAuthLoading(loading) {
  if (!refs.authSubmit) return;
  refs.authSubmit.disabled = loading;
  refs.authSubmit.textContent = loading ? 'Checking...' : 'Authenticate';
}

function setAuthError(message) {
  refs.authError.textContent = message || '';
}

function showToast(message, type = 'success') {
  refs.toast.textContent = message;
  refs.toast.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    refs.toast.className = 'toast';
  }, 2600);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatDate(timestamp) {
  return new Date(Number(timestamp || 0)).toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateTime(timestamp) {
  return new Date(Number(timestamp || 0)).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
