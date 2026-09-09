/**
 * Pure helpers for the region tree and the access control list.
 *
 * Kept free of Vue and of the serial layer so the diffing rules - which decide
 * what actually gets written to a device - can be tested on their own.
 */

/** uid of the "*" wildcard region, which is always the root of the tree */
export const ROOT_UID = 'root';

// ------------------------------------------------------------------ regions

/**
 * Mirrors RegionMap::is_name_char() in the firmware, minus '|' which separates
 * segments in `region def` and would be ambiguous.
 * @param {string} name
 */
export function isValidRegionName(name) {
  if (!name || name.length > 30) return false;
  for (const ch of name) {
    const ok = ch === '-' || ch === '$' || ch === '#'
      || (ch >= '0' && ch <= '9') || ch >= 'A';
    if (!ok || ch === '|') return false;
  }
  return true;
}

const childrenOf = (list, uid) => list.filter((r) => r.parentUid === uid);

/** Descendants of `uid` in pre-order, i.e. parents always before children */
export function regionDescendants(list, uid) {
  const out = [];
  const walk = (u) => {
    for (const child of childrenOf(list, u)) { out.push(child); walk(child.uid); }
  };
  walk(uid);
  return out;
}

export function regionDepth(list, uid) {
  let depth = 0;
  let cur = list.find((r) => r.uid === uid);
  while (cur && cur.parentUid) {
    depth++;
    cur = list.find((r) => r.uid === cur.parentUid);
  }
  return depth;
}

/** Regions that may be picked as the parent of `uid` (not itself, not its own descendants) */
export function regionParentOptions(list, uid) {
  const blocked = new Set([uid, ...regionDescendants(list, uid).map((r) => r.uid)]);
  return list.filter((r) => !blocked.has(r.uid));
}

/**
 * Turn an edited region tree into the CLI commands that bring the device to
 * that state.
 *
 * Order matters:
 *  1. creates / renames / re-parents, parents before children, so nothing is
 *     removed while it still has children;
 *  2. removals, deepest first - including the entry a rename leaves behind;
 *  3. the default region, then the home region. Both are stored by id, so
 *     renaming their target orphans the pointer and it has to be re-issued;
 *  4. flood flags last, because `region put` and `region default` each reset a
 *     region to flood-allowed.
 *
 * @param {{list: Array, homeUid: string, defaultUid: string, supportsDefault: boolean}} current
 * @param {{list: Array, homeUid: string, defaultUid: string}} device
 * @returns {string[]} commands, ending with `region save` when non-empty
 */
export function buildRegionCommands(current, device) {
  const cmds = [];

  const prevByUid = new Map(device.list.map((r) => [r.uid, r]));
  const nowByUid = new Map(current.list.map((r) => [r.uid, r]));
  const prevName = (uid) => prevByUid.get(uid)?.name;
  const nowName = (uid) => nowByUid.get(uid)?.name;
  const putCmd = (name, parentName) =>
    `region put ${name}${!parentName || parentName === '*' ? '' : ` ${parentName}`}`;

  // Flood flag each region will have once the steps below have run
  const expectedFlood = new Map(device.list.map((r) => [r.uid, r.flood]));
  const renamed = new Set();

  // 1. create, rename and re-parent - parents before children
  for (const r of regionDescendants(current.list, ROOT_UID)) {
    const prev = prevByUid.get(r.uid);
    const parentName = nowName(r.parentUid) || '*';
    const prevParentName = prev ? (prevName(prev.parentUid) || '*') : null;

    if (!prev || prev.name !== r.name || prevParentName !== parentName) {
      cmds.push(putCmd(r.name, parentName));
      expectedFlood.set(r.uid, true);
      if (prev && prev.name !== r.name) renamed.add(r.uid);
    }
  }

  // 2. remove regions the user deleted, deepest first
  const removals = device.list
    .filter((r) => r.uid !== ROOT_UID && !nowByUid.has(r.uid))
    .sort((a, b) => regionDepth(device.list, b.uid) - regionDepth(device.list, a.uid))
    .map((r) => r.name);

  // A rename leaves the original entry behind. Its children were re-parented
  // onto the new entry in step 1, so it is safe to drop, deepest first.
  const staleNames = [...renamed]
    .sort((a, b) => regionDepth(device.list, b) - regionDepth(device.list, a))
    .map((uid) => prevName(uid));

  for (const name of [...removals, ...staleNames]) cmds.push(`region remove ${name}`);

  // 3. default region
  if (current.supportsDefault) {
    const changed = current.defaultUid !== device.defaultUid
      || (current.defaultUid && renamed.has(current.defaultUid));
    if (changed) {
      const name = nowName(current.defaultUid);
      cmds.push(`region default ${name || '<null>'}`);
      if (name) expectedFlood.set(current.defaultUid, true);
    }
  }

  // 4. home region
  const homeChanged = current.homeUid !== device.homeUid
    || (current.homeUid !== ROOT_UID && renamed.has(current.homeUid));
  if (homeChanged) cmds.push(`region home ${nowName(current.homeUid) || '*'}`);

  // 5. flood flags
  for (const r of current.list) {
    if (expectedFlood.get(r.uid) !== r.flood) {
      cmds.push(`region ${r.flood ? 'allowf' : 'denyf'} ${r.name}`);
    }
  }

  if (cmds.length) cmds.push('region save');
  return cmds;
}

/**
 * @param {Array} list
 * @returns {string|null} an error message, or null when the tree is valid
 */
export function validateRegions(list) {
  const seen = new Set();
  for (const r of list) {
    if (r.uid === ROOT_UID) continue;
    const name = String(r.name || '').trim();
    if (!name) return 'Every region needs a name.';
    if (!isValidRegionName(name)) {
      return `"${name}" is not a valid region name. Use letters, digits, "-", "#" or "$" with no spaces.`;
    }
    if (seen.has(name.toLowerCase())) return `Duplicate region name: "${name}".`;
    seen.add(name.toLowerCase());
  }
  return null;
}

// ---------------------------------------------------------------------- acl

/** Role lives in the low 2 bits of the permission byte; role 0 (guest) is not persisted */
export const ACL_ROLE_MASK = 3;

export const ACL_ROLES = [
  { value: 1, label: 'Read only' },
  { value: 2, label: 'Read / write' },
  { value: 3, label: 'Admin' },
];

export const aclRole = (entry) => entry.perms & ACL_ROLE_MASK;

export function setAclRole(entry, role) {
  entry.perms = (entry.perms & ~ACL_ROLE_MASK) | (Number(role) & ACL_ROLE_MASK);
}

export const isValidPubKey = (key) => /^[0-9a-f]{64}$/i.test(String(key || '').trim());

/**
 * Diff the edited access list against the device's.
 * Setting a client to permission 0 is how the firmware deletes them.
 *
 * @param {Array<{uid: string, pubkey: string, perms: number}>} list
 * @param {Array<{uid: string, pubkey: string, perms: number}>} deviceList
 * @returns {string[]} `setperm` commands
 */
export function buildAclCommands(list, deviceList) {
  const cmds = [];
  const prevByUid = new Map(deviceList.map((c) => [c.uid, c]));
  const kept = new Set();

  for (const entry of list) {
    kept.add(entry.uid);
    const key = String(entry.pubkey || '').trim().toLowerCase();
    if (!isValidPubKey(key)) continue;   // half-typed row; validateAcl() blocks the save

    const prev = prevByUid.get(entry.uid);
    if (prev && prev.pubkey !== key) cmds.push(`setperm ${prev.pubkey} 0`);
    if (!prev || prev.pubkey !== key || prev.perms !== entry.perms) {
      cmds.push(`setperm ${key} ${entry.perms}`);
    }
  }

  for (const prev of deviceList) {
    if (!kept.has(prev.uid)) cmds.push(`setperm ${prev.pubkey} 0`);
  }
  return cmds;
}

/**
 * @param {Array} list
 * @returns {string|null} an error message, or null when the list is valid
 */
export function validateAcl(list) {
  const seen = new Set();
  for (const entry of list) {
    const key = String(entry.pubkey || '').trim().toLowerCase();
    if (!isValidPubKey(key)) {
      return `"${entry.pubkey || '(empty)'}" is not a valid public key. Expected 64 hex characters.`;
    }
    if (seen.has(key)) return `Duplicate public key: ${key.slice(0, 12)}...`;
    seen.add(key);
  }
  return null;
}
