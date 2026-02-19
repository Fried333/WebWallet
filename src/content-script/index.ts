// Verus Web Wallet - Content Script
// Injects the Verus provider into web pages for dApp integration

const injectProvider = () => {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
};

injectProvider();

// Relay messages from page → background
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.target !== 'verus-wallet-contentscript') return;

  const payload = event.data.payload;

  // Only relay allowed message types — all others are rejected.
  // Defense-in-depth: background also validates sender origin.
  if (payload?.type === 'DAPP_LOGIN_DEEPLINK') {
    if (typeof payload.uri !== 'string') return;
    const reqId = typeof payload._reqId === 'number' && Number.isSafeInteger(payload._reqId)
      ? payload._reqId
      : undefined;
    chrome.runtime.sendMessage({
      type: 'DAPP_LOGIN_DEEPLINK',
      payload: { uri: payload.uri, _reqId: reqId },
    });
  }

  if (payload?.type === 'DAPP_SEND_REQUEST') {
    // Sanitize all fields before relaying to background
    if (typeof payload.to !== 'string' || typeof payload.amount !== 'number') return;
    const reqId = typeof payload._reqId === 'number' && Number.isSafeInteger(payload._reqId)
      ? payload._reqId
      : undefined;
    const currency = typeof payload.currency === 'string' ? payload.currency : undefined;
    chrome.runtime.sendMessage({
      type: 'DAPP_SEND_REQUEST',
      payload: {
        to: payload.to,
        amount: payload.amount,
        currency,
        _reqId: reqId,
      },
    });
  }
});

// Relay messages from background → page (dApp responses)
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'DAPP_RESPONSE' || message?.type === 'DAPP_SEND_RESPONSE') {
    window.postMessage(
      { target: 'verus-wallet-page', payload: message },
      window.location.origin
    );
  }
});

export {};
