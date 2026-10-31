const ROLES = Object.freeze(['user', 'moderator', 'admin', 'owner']);
const STATUSES = Object.freeze(['active', 'suspended', 'banned', 'disabled']);

const ROLE_LEVELS = Object.freeze({
  user: 1,
  moderator: 2,
  admin: 3,
  owner: 4
});

function normalizeRole(role) {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function normalizeStatus(status) {
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function isValidRole(role) {
  return ROLES.includes(normalizeRole(role));
}

function isValidStatus(status) {
  return STATUSES.includes(normalizeStatus(status));
}

function roleLevel(role) {
  return ROLE_LEVELS[normalizeRole(role)] || 0;
}

function hasRole(userRole, requiredRole) {
  return roleLevel(userRole) >= roleLevel(requiredRole);
}

function hasAnyRole(userRole, requiredRoles) {
  return requiredRoles.some((role) => hasRole(userRole, role));
}

function canChangeUserStatus(actor, target) {
  if (!actor || !target) return false;
  if (!hasAnyRole(actor.role, ['owner', 'admin'])) return false;
  if (actor.userId === target.id) return false;
  if (actor.role === 'owner') return true;
  return roleLevel(actor.role) > roleLevel(target.role);
}

module.exports = {
  ROLES,
  STATUSES,
  ROLE_LEVELS,
  normalizeRole,
  normalizeStatus,
  isValidRole,
  isValidStatus,
  roleLevel,
  hasRole,
  hasAnyRole,
  canChangeUserStatus
};
