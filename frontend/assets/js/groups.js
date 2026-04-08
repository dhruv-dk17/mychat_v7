'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 13 — Group Management Module
// ═══════════════════════════════════════════════════════════════════
//
// Features:
//   1. Group lifecycle: create, update info, delete
//   2. Member management: add, remove, promote, demote
//   3. Role system: owner (1), admin (n), member (n)
//   4. Group settings: admin-only send, join approval, max members
//   5. P2P group sync protocol messages
//   6. Group avatar generation (initials + color)
//   7. Persisted in IndexedDB contacts store (type: 'group')
//
// Architecture:
//   - Groups are stored as special records in IndexedDB
//   - Group sync uses P2P messages: group_invite, group_join, etc.
//   - Compatible with existing room model (group rooms)
//   - Owner is the identity that created the group
//
// Zero external dependencies.
// ═══════════════════════════════════════════════════════════════════

const GroupManager = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const GROUP_STORE = 'contacts'; // Groups stored alongside contacts
  const GROUP_PREFIX = 'group:';
  const MAX_GROUP_MEMBERS = 50;
  const AVATAR_COLORS = [
    '#7c3aed', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b',
    '#ef4444', '#ec4899', '#8b5cf6', '#6366f1', '#14b8a6'
  ];

  // ── State ─────────────────────────────────────────────────────
  let _initialized = false;
  let _groups = new Map(); // groupId -> group data
  let _listeners = [];

  // ── Events ────────────────────────────────────────────────────
  function emit(event, data) {
    _listeners.forEach(listener => {
      if (listener.event === event || listener.event === '*') {
        try { listener.callback(data); } catch (e) {}
      }
    });
    try {
      window.dispatchEvent(new CustomEvent(`mychat:group:${event}`, { detail: data }));
    } catch (e) {}
  }

  function on(event, callback) {
    _listeners.push({ event, callback });
    return () => {
      _listeners = _listeners.filter(l => l.callback !== callback);
    };
  }

  // ── Avatar generation ─────────────────────────────────────────
  function generateAvatarColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function getInitials(name) {
    if (!name) return '??';
    const words = name.trim().split(/\s+/);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  }

  // ── Group ID generation ───────────────────────────────────────
  function generateGroupId() {
    const arr = crypto.getRandomValues(new Uint8Array(12));
    return GROUP_PREFIX + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Persistence ───────────────────────────────────────────────
  async function saveGroupToDB(group) {
    if (typeof dbPut !== 'function') {
      console.warn('[Groups] dbPut not available');
      return;
    }
    const record = {
      ...group,
      _type: 'group',
      fingerprint: group.id // Use group ID as fingerprint key
    };
    await dbPut(GROUP_STORE, group.id, record);
    _groups.set(group.id, group);
  }

  async function loadGroupFromDB(groupId) {
    if (typeof dbGet !== 'function') return null;
    try {
      const record = await dbGet(GROUP_STORE, groupId);
      if (!record || record._type !== 'group') return null;
      _groups.set(groupId, record);
      return record;
    } catch (error) {
      return null;
    }
  }

  async function deleteGroupFromDB(groupId) {
    if (typeof dbDelete !== 'function') return;
    await dbDelete(GROUP_STORE, groupId);
    _groups.delete(groupId);
  }

  async function loadAllGroupsFromDB() {
    if (typeof dbGetAll !== 'function') return [];
    try {
      const all = await dbGetAll(GROUP_STORE);
      const groups = all.filter(r => r._type === 'group');
      groups.forEach(g => _groups.set(g.id, g));
      return groups;
    } catch (error) {
      return [];
    }
  }

  // ── Identity helpers ──────────────────────────────────────────
  function getOwnFingerprint() {
    if (typeof getIdentityFingerprintSync === 'function') {
      return getIdentityFingerprintSync();
    }
    return '';
  }

  // ── Role checks ───────────────────────────────────────────────
  function isOwner(group, fingerprint) {
    return group?.createdBy === fingerprint;
  }

  function isAdmin(group, fingerprint) {
    if (!group) return false;
    if (isOwner(group, fingerprint)) return true;
    return Array.isArray(group.admins) && group.admins.includes(fingerprint);
  }

  function isMember(group, fingerprint) {
    if (!group) return false;
    return Array.isArray(group.members) && group.members.some(
      m => (typeof m === 'string' ? m : m.fingerprint) === fingerprint
    );
  }

  function getMemberFingerprint(member) {
    return typeof member === 'string' ? member : member.fingerprint;
  }

  // ── Core operations ───────────────────────────────────────────

  /**
   * Create a new group.
   * @param {string} name - Group display name
   * @param {string} [description] - Group description
   * @param {Array} [initialMembers] - Array of fingerprints to invite
   * @returns {Object} The created group
   */
  async function createGroup(name, description = '', initialMembers = []) {
    if (!name || name.trim().length < 1) {
      throw new Error('Group name is required');
    }

    const ownFp = getOwnFingerprint();
    if (!ownFp) throw new Error('Identity not initialized');

    const groupId = generateGroupId();
    const now = Date.now();

    const group = {
      id: groupId,
      name: name.trim(),
      description: description.trim(),
      avatarColor: generateAvatarColor(name),
      initials: getInitials(name),
      createdBy: ownFp,
      createdAt: now,
      updatedAt: now,
      members: [
        { fingerprint: ownFp, joinedAt: now, role: 'owner', displayName: '' }
      ],
      admins: [ownFp],
      settings: {
        onlyAdminsCanSend: false,
        onlyAdminsCanEditInfo: true,
        maxMembers: MAX_GROUP_MEMBERS,
        joinApproval: false
      }
    };

    // Add initial members
    for (const fp of initialMembers) {
      if (fp === ownFp) continue;
      if (group.members.length >= MAX_GROUP_MEMBERS) break;
      group.members.push({
        fingerprint: getMemberFingerprint(fp),
        joinedAt: now,
        role: 'member',
        displayName: ''
      });
    }

    await saveGroupToDB(group);
    emit('created', { group });

    // Send invites via P2P if broadcastOrRelay is available
    if (typeof broadcastOrRelay === 'function') {
      for (const member of group.members) {
        if (member.fingerprint === ownFp) continue;
        try {
          broadcastOrRelay({
            type: 'group_invite',
            groupId: group.id,
            groupName: group.name,
            invitedBy: ownFp,
            timestamp: now
          });
        } catch (e) {}
      }
    }

    return group;
  }

  /**
   * Get a group by ID.
   */
  async function getGroup(groupId) {
    return _groups.get(groupId) || await loadGroupFromDB(groupId);
  }

  /**
   * Get all groups the user is a member of.
   */
  async function getAllGroups() {
    if (!_groups.size) await loadAllGroupsFromDB();
    const ownFp = getOwnFingerprint();
    return [..._groups.values()].filter(g => isMember(g, ownFp));
  }

  /**
   * Update group info (name, description).
   */
  async function updateGroupInfo(groupId, updates) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (group.settings.onlyAdminsCanEditInfo && !isAdmin(group, ownFp)) {
      throw new Error('Only admins can edit group info');
    }

    if (updates.name !== undefined) {
      group.name = String(updates.name).trim();
      group.initials = getInitials(group.name);
      group.avatarColor = generateAvatarColor(group.name);
    }
    if (updates.description !== undefined) {
      group.description = String(updates.description).trim();
    }
    group.updatedAt = Date.now();

    await saveGroupToDB(group);
    emit('updated', { group, updates });

    // Broadcast update
    if (typeof broadcastOrRelay === 'function') {
      broadcastOrRelay({
        type: 'group_info_update',
        groupId: group.id,
        name: group.name,
        description: group.description,
        updatedBy: ownFp,
        timestamp: group.updatedAt
      });
    }

    return group;
  }

  /**
   * Update group settings.
   */
  async function updateGroupSettings(groupId, settings) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (!isAdmin(group, ownFp)) {
      throw new Error('Only admins can change group settings');
    }

    group.settings = { ...group.settings, ...settings };
    group.updatedAt = Date.now();
    await saveGroupToDB(group);
    emit('settings_updated', { group, settings });
    return group;
  }

  /**
   * Add a member to the group (admin only).
   */
  async function addMember(groupId, fingerprint, displayName = '') {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (!isAdmin(group, ownFp)) {
      throw new Error('Only admins can add members');
    }

    if (isMember(group, fingerprint)) {
      throw new Error('User is already a member');
    }

    if (group.members.length >= (group.settings.maxMembers || MAX_GROUP_MEMBERS)) {
      throw new Error(`Group is full (max ${group.settings.maxMembers || MAX_GROUP_MEMBERS} members)`);
    }

    group.members.push({
      fingerprint,
      joinedAt: Date.now(),
      role: 'member',
      displayName
    });
    group.updatedAt = Date.now();

    await saveGroupToDB(group);
    emit('member_added', { group, fingerprint });

    // Send invite
    if (typeof broadcastOrRelay === 'function') {
      broadcastOrRelay({
        type: 'group_invite',
        groupId: group.id,
        groupName: group.name,
        invitedBy: ownFp,
        targetFingerprint: fingerprint,
        timestamp: Date.now()
      });
    }

    return group;
  }

  /**
   * Remove a member from the group (admin only).
   */
  async function removeMember(groupId, fingerprint) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (!isAdmin(group, ownFp)) {
      throw new Error('Only admins can remove members');
    }

    if (isOwner(group, fingerprint)) {
      throw new Error('Cannot remove the group owner');
    }

    group.members = group.members.filter(
      m => getMemberFingerprint(m) !== fingerprint
    );
    group.admins = group.admins.filter(a => a !== fingerprint);
    group.updatedAt = Date.now();

    await saveGroupToDB(group);
    emit('member_removed', { group, fingerprint });

    // Broadcast removal
    if (typeof broadcastOrRelay === 'function') {
      broadcastOrRelay({
        type: 'group_leave',
        groupId: group.id,
        fingerprint,
        removedBy: ownFp,
        timestamp: Date.now()
      });
    }

    return group;
  }

  /**
   * Leave a group (self-remove).
   */
  async function leaveGroup(groupId) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (isOwner(group, ownFp)) {
      // Transfer ownership to next admin, or delete if sole member
      if (group.members.length <= 1) {
        await deleteGroupFromDB(groupId);
        emit('deleted', { groupId });
        return null;
      }

      const nextAdmin = group.admins.find(a => a !== ownFp) ||
        getMemberFingerprint(group.members.find(m => getMemberFingerprint(m) !== ownFp));
      if (nextAdmin) {
        group.createdBy = nextAdmin;
        if (!group.admins.includes(nextAdmin)) group.admins.push(nextAdmin);
        const memberEntry = group.members.find(m => getMemberFingerprint(m) === nextAdmin);
        if (memberEntry) memberEntry.role = 'owner';
      }
    }

    group.members = group.members.filter(
      m => getMemberFingerprint(m) !== ownFp
    );
    group.admins = group.admins.filter(a => a !== ownFp);
    group.updatedAt = Date.now();

    await saveGroupToDB(group);
    emit('left', { groupId, fingerprint: ownFp });

    // Announce departure
    if (typeof broadcastOrRelay === 'function') {
      broadcastOrRelay({
        type: 'group_leave',
        groupId: group.id,
        fingerprint: ownFp,
        timestamp: Date.now()
      });
    }

    return group;
  }

  /**
   * Promote a member to admin.
   */
  async function promoteToAdmin(groupId, fingerprint) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (!isOwner(group, ownFp) && !isAdmin(group, ownFp)) {
      throw new Error('Only the owner or admins can promote members');
    }

    if (!isMember(group, fingerprint)) {
      throw new Error('User is not a member of this group');
    }

    if (!group.admins.includes(fingerprint)) {
      group.admins.push(fingerprint);
    }

    const memberEntry = group.members.find(m => getMemberFingerprint(m) === fingerprint);
    if (memberEntry) memberEntry.role = 'admin';

    group.updatedAt = Date.now();
    await saveGroupToDB(group);
    emit('member_promoted', { group, fingerprint });

    return group;
  }

  /**
   * Demote an admin to regular member.
   */
  async function demoteFromAdmin(groupId, fingerprint) {
    const group = await getGroup(groupId);
    if (!group) throw new Error('Group not found');

    const ownFp = getOwnFingerprint();
    if (!isOwner(group, ownFp)) {
      throw new Error('Only the owner can demote admins');
    }

    if (fingerprint === ownFp) {
      throw new Error('Cannot demote yourself');
    }

    group.admins = group.admins.filter(a => a !== fingerprint);
    const memberEntry = group.members.find(m => getMemberFingerprint(m) === fingerprint);
    if (memberEntry) memberEntry.role = 'member';

    group.updatedAt = Date.now();
    await saveGroupToDB(group);
    emit('member_demoted', { group, fingerprint });

    return group;
  }

  // ── P2P message handlers ──────────────────────────────────────

  /**
   * Handle incoming group-related P2P messages.
   */
  function handleGroupMessage(msg) {
    if (!msg?.type) return false;

    switch (msg.type) {
      case 'group_invite':
        handleGroupInvite(msg);
        return true;
      case 'group_join':
        handleGroupJoin(msg);
        return true;
      case 'group_leave':
        handleGroupLeave(msg);
        return true;
      case 'group_info_update':
        handleGroupInfoUpdate(msg);
        return true;
      case 'group_member_list':
        handleGroupMemberList(msg);
        return true;
      default:
        return false;
    }
  }

  async function handleGroupInvite(msg) {
    const ownFp = getOwnFingerprint();
    const existingGroup = await getGroup(msg.groupId);

    if (!existingGroup) {
      // Store new group from invite
      const group = {
        id: msg.groupId,
        name: msg.groupName || 'Group',
        description: '',
        avatarColor: generateAvatarColor(msg.groupName || 'Group'),
        initials: getInitials(msg.groupName || 'Group'),
        createdBy: msg.invitedBy || '',
        createdAt: msg.timestamp || Date.now(),
        updatedAt: Date.now(),
        members: [
          { fingerprint: msg.invitedBy, joinedAt: msg.timestamp || Date.now(), role: 'owner', displayName: '' },
          { fingerprint: ownFp, joinedAt: Date.now(), role: 'member', displayName: '' }
        ],
        admins: [msg.invitedBy || ''],
        settings: {
          onlyAdminsCanSend: false,
          onlyAdminsCanEditInfo: true,
          maxMembers: MAX_GROUP_MEMBERS,
          joinApproval: false
        }
      };

      await saveGroupToDB(group);
      emit('invited', { group, invitedBy: msg.invitedBy });

      if (typeof showToast === 'function') {
        showToast(`Added to group: ${group.name}`, 'info');
      }
    }
  }

  async function handleGroupJoin(msg) {
    const group = await getGroup(msg.groupId);
    if (!group) return;

    const fp = msg.fingerprint || msg.from;
    if (fp && !isMember(group, fp)) {
      group.members.push({
        fingerprint: fp,
        joinedAt: msg.timestamp || Date.now(),
        role: 'member',
        displayName: msg.displayName || ''
      });
      group.updatedAt = Date.now();
      await saveGroupToDB(group);
      emit('member_joined', { group, fingerprint: fp });
    }
  }

  async function handleGroupLeave(msg) {
    const group = await getGroup(msg.groupId);
    if (!group) return;

    const fp = msg.fingerprint || msg.from;
    if (fp) {
      group.members = group.members.filter(m => getMemberFingerprint(m) !== fp);
      group.admins = group.admins.filter(a => a !== fp);
      group.updatedAt = Date.now();
      await saveGroupToDB(group);
      emit('member_left', { group, fingerprint: fp });
    }
  }

  async function handleGroupInfoUpdate(msg) {
    const group = await getGroup(msg.groupId);
    if (!group) return;

    // Apply updates from a trusted admin (timestamp ordering for conflicts)
    if (msg.timestamp && msg.timestamp > group.updatedAt) {
      if (msg.name) {
        group.name = msg.name;
        group.initials = getInitials(msg.name);
        group.avatarColor = generateAvatarColor(msg.name);
      }
      if (msg.description !== undefined) {
        group.description = msg.description;
      }
      group.updatedAt = msg.timestamp;
      await saveGroupToDB(group);
      emit('info_updated', { group });
    }
  }

  async function handleGroupMemberList(msg) {
    const group = await getGroup(msg.groupId);
    if (!group) return;

    // Sync member list from host
    if (Array.isArray(msg.members) && msg.timestamp > group.updatedAt) {
      group.members = msg.members;
      group.admins = msg.admins || group.admins;
      group.updatedAt = msg.timestamp;
      await saveGroupToDB(group);
      emit('members_synced', { group });
    }
  }

  /**
   * Broadcast current member list to all peers (admin/host sends).
   */
  async function broadcastMemberList(groupId) {
    const group = await getGroup(groupId);
    if (!group) return;

    const ownFp = getOwnFingerprint();
    if (!isAdmin(group, ownFp)) return;

    if (typeof broadcastOrRelay === 'function') {
      broadcastOrRelay({
        type: 'group_member_list',
        groupId: group.id,
        members: group.members,
        admins: group.admins,
        timestamp: Date.now()
      });
    }
  }

  // ── Group permission checks ───────────────────────────────────
  function canSendMessage(group, fingerprint) {
    if (!group || !isMember(group, fingerprint)) return false;
    if (group.settings.onlyAdminsCanSend) return isAdmin(group, fingerprint);
    return true;
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    if (_initialized) return;
    _initialized = true;
    await loadAllGroupsFromDB();
    console.log('[Groups] Initialized. Groups:', _groups.size);
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    on,
    createGroup,
    getGroup,
    getAllGroups,
    updateGroupInfo,
    updateGroupSettings,
    addMember,
    removeMember,
    leaveGroup,
    promoteToAdmin,
    demoteFromAdmin,
    handleGroupMessage,
    broadcastMemberList,
    canSendMessage,
    isOwner,
    isAdmin,
    isMember,
    getInitials,
    generateAvatarColor
  };
})();

// ── Wire to global scope ────────────────────────────────────────
window.GroupManager = GroupManager;
