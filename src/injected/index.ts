// Verus Web Wallet - Injected Page-World Script
// MetaMask-style provider: intercepts verus:// deep links AND exposes window.verus API
// Handles: <a> clicks, window.location assignments, window.open, programmatic navigation

(function () {
  const VERUS_PROTOCOLS = ['verus://', 'vrsc://'];
  // Legacy VerusID VDXF key protocol (i5jtwbp6... lowercased)
  const LEGACY_PROTOCOL = 'i5jtwbp6zymeay9llnraglgjqgdrffsau4://';

  function isVerusUri(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return VERUS_PROTOCOLS.some(p => lower.startsWith(p)) || lower.startsWith(LEGACY_PROTOCOL);
  }

  function relayDeeplink(uri: string): void {
    window.postMessage(
      {
        target: 'verus-wallet-contentscript',
        payload: { type: 'DAPP_LOGIN_DEEPLINK', uri },
      },
      window.location.origin,
    );
  }

  // --- Pending request tracking (for promise-based API) ---
  let requestCounter = 0;
  const PENDING_TIMEOUT_MS = 5 * 60_000; // 5 minutes
  const pendingRequests = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();

  // Listen for responses from the content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.target !== 'verus-wallet-page') return;

    const payload = event.data.payload;
    if (!payload) return;

    // Resolve pending provider API calls
    if ((payload.type === 'DAPP_RESPONSE' || payload.type === 'DAPP_SEND_RESPONSE') && payload._reqId != null) {
      const pending = pendingRequests.get(payload._reqId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(payload._reqId);
        if (payload.success) {
          pending.resolve(payload.data);
        } else {
          pending.reject(new Error(payload.error ?? 'Request rejected'));
        }
      }
    }
  });

  // --- 1. Provider API (MetaMask-style window.verus) ---
  const provider = {
    isVerusWallet: true,
    version: '0.1.0',

    /** Request login consent — website passes a verus:// deep link URI */
    requestLogin(uri: string): Promise<any> {
      if (!uri || !isVerusUri(uri)) {
        return Promise.reject(new Error('Invalid Verus login URI'));
      }
      const id = ++requestCounter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error('Request timed out'));
        }, PENDING_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        window.postMessage(
          {
            target: 'verus-wallet-contentscript',
            payload: { type: 'DAPP_LOGIN_DEEPLINK', uri, _reqId: id },
          },
          window.location.origin,
        );
      });
    },

    /** Send a raw deep link URI to the extension */
    sendDeeplink(uri: string): Promise<any> {
      return this.requestLogin(uri);
    },

    /** Request a transaction send — opens the extension popup for approval */
    sendTransaction(params: { to: string; amount: number; currency?: string }): Promise<{ txid: string }> {
      if (!params?.to || !params?.amount) {
        return Promise.reject(new Error('Missing to or amount'));
      }
      // Validate address: must be a non-empty ASCII string of reasonable length
      if (typeof params.to !== 'string' || params.to.length < 25 || params.to.length > 100) {
        return Promise.reject(new Error('Invalid address format'));
      }
      if (!/^[\x20-\x7E]+$/.test(params.to)) {
        return Promise.reject(new Error('Address contains invalid characters'));
      }
      // Validate amount: must be a positive finite number
      if (typeof params.amount !== 'number' || !Number.isFinite(params.amount) || params.amount <= 0) {
        return Promise.reject(new Error('Invalid amount'));
      }
      // Validate currency: alphanumeric, dots, or i-address format only
      if (params.currency != null) {
        if (typeof params.currency !== 'string' || !/^[a-zA-Z0-9.]+$/.test(params.currency)) {
          return Promise.reject(new Error('Invalid currency'));
        }
      }
      const id = ++requestCounter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error('Request timed out'));
        }, PENDING_TIMEOUT_MS);
        pendingRequests.set(id, { resolve, reject, timer });
        window.postMessage(
          {
            target: 'verus-wallet-contentscript',
            payload: {
              type: 'DAPP_SEND_REQUEST',
              to: params.to,
              amount: params.amount,
              currency: params.currency || 'VRSC',
              _reqId: id,
            },
          },
          window.location.origin,
        );
      });
    },
  };

  // Define non-configurable so sites can reliably detect us
  Object.defineProperty(window, 'verus', {
    value: Object.freeze(provider),
    writable: false,
    configurable: false,
  });

  // Also dispatch a custom event so sites waiting for the provider can detect it
  window.dispatchEvent(new CustomEvent('verus#initialized'));

  // --- 2. Intercept <a> clicks (capture phase) ---
  document.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest?.('a');
    if (!target) return;

    const href = target.getAttribute('href');
    if (!href || !isVerusUri(href)) return;

    event.preventDefault();
    event.stopPropagation();
    relayDeeplink(href);
  }, true);

  // --- 3. Intercept window.location.href assignments ---
  try {
    // We can't override window.location directly (it's special), but we can
    // intercept Location.prototype.assign and Location.prototype.replace
    const origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url: string) {
      if (isVerusUri(url)) {
        relayDeeplink(url);
        return;
      }
      return origAssign.call(this, url);
    };

    const origReplace = Location.prototype.replace;
    Location.prototype.replace = function (url: string) {
      if (isVerusUri(url)) {
        relayDeeplink(url);
        return;
      }
      return origReplace.call(this, url);
    };

    // Intercept setting location.href via property descriptor
    const hrefDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (hrefDescriptor?.set) {
      const origHrefSet = hrefDescriptor.set;
      Object.defineProperty(Location.prototype, 'href', {
        ...hrefDescriptor,
        set(value: string) {
          if (isVerusUri(value)) {
            relayDeeplink(value);
            return;
          }
          origHrefSet.call(this, value);
        },
      });
    }
  } catch {
    // Some browsers may restrict modifying Location — graceful fallback
  }

  // --- 4. Intercept window.open ---
  const origOpen = window.open.bind(window);
  (window as any).open = function (url?: string | URL, target?: string, features?: string) {
    const urlStr = url?.toString();
    if (urlStr && isVerusUri(urlStr)) {
      relayDeeplink(urlStr);
      return null;
    }
    return origOpen(url, target, features);
  };

  // --- 5. Intercept dynamically created <a> elements clicked via JS ---
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute('href');
    if (href && isVerusUri(href)) {
      relayDeeplink(href);
      return;
    }
    return origClick.call(this);
  };
})();
