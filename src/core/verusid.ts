// VerusID RPC client — identity lookups via public Verus API

const VERUS_RPC_URL = 'https://api.verus.services/';
const REQUEST_TIMEOUT = 15_000;
const MAX_INPUT_LENGTH = 200;

// Only allow printable ASCII — no control chars, no Unicode trickery
const SAFE_INPUT_RE = /^[\x20-\x7E]+$/;

export interface VerusIdentity {
  name: string;
  parent: string;
  identityaddress: string;
  primaryaddresses: string[];
  minimumsignatures: number;
  recoveryauthority: string;
  revocationauthority: string;
  systemid: string;
  flags: number;
  version: number;
  contentmap: Record<string, string>;
  contentmultimap: Record<string, unknown>;
  timelock: number;
}

export interface GetIdentityResult {
  identity: VerusIdentity;
  status: string;
  friendlyname: string;
  fullyqualifiedname: string;
  blockheight: number;
  txid: string;
  vout: number;
}

function validateInput(value: string, label: string): void {
  if (!value || value.length > MAX_INPUT_LENGTH) {
    throw new Error(`${label} is empty or too long (max ${MAX_INPUT_LENGTH} chars)`);
  }
  if (!SAFE_INPUT_RE.test(value)) {
    throw new Error(`${label} contains invalid characters`);
  }
}

function validateIdentityResult(result: unknown): GetIdentityResult {
  const r = result as Record<string, unknown>;
  if (!r || typeof r !== 'object') throw new Error('Invalid identity response');

  const identity = r.identity as Record<string, unknown>;
  if (!identity || typeof identity !== 'object') throw new Error('Missing identity object');
  if (typeof identity.identityaddress !== 'string') throw new Error('Missing identityaddress');
  if (!Array.isArray(identity.primaryaddresses)) throw new Error('Missing primaryaddresses');
  // Validate each primary address is a string
  for (const addr of identity.primaryaddresses) {
    if (typeof addr !== 'string') throw new Error('Invalid primaryaddress entry');
  }
  if (typeof identity.name !== 'string') throw new Error('Missing identity name');

  if (typeof r.friendlyname !== 'string') throw new Error('Missing friendlyname');
  if (typeof r.status !== 'string') throw new Error('Missing status');

  return r as unknown as GetIdentityResult;
}

export async function getIdentity(nameOrIAddress: string): Promise<GetIdentityResult> {
  validateInput(nameOrIAddress, 'Identity name/address');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(VERUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: 1,
        method: 'getidentity',
        params: [nameOrIAddress],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP error: ${res.status}`);
    }

    const json = await res.json();

    if (json.error) {
      throw new Error(json.error.message ?? 'Identity lookup failed');
    }

    return validateIdentityResult(json.result);
  } finally {
    clearTimeout(timer);
  }
}

/** Look up all VerusIDs that have the given R-address as a primary address */
export async function getIdentitiesByAddress(address: string): Promise<VerusIdentity[]> {
  validateInput(address, 'Address');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(VERUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: 1,
        method: 'getidentitieswithaddress',
        params: [{ address }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`RPC HTTP error: ${res.status}`);
    }

    const json = await res.json();

    if (json.error) {
      throw new Error(json.error.message ?? 'Identity lookup failed');
    }

    const result = json.result;
    if (!Array.isArray(result)) throw new Error('Invalid identities response');
    // Validate each identity entry has required fields
    for (let i = 0; i < result.length; i++) {
      const id = result[i];
      if (!id || typeof id !== 'object') throw new Error(`Identity[${i}]: not an object`);
      if (typeof id.name !== 'string') throw new Error(`Identity[${i}]: missing name`);
      if (typeof id.identityaddress !== 'string') throw new Error(`Identity[${i}]: missing identityaddress`);
      if (!Array.isArray(id.primaryaddresses)) throw new Error(`Identity[${i}]: missing primaryaddresses`);
    }
    return result as VerusIdentity[];
  } finally {
    clearTimeout(timer);
  }
}
