import { consumeQcReturnPath, initQcAuth } from './src/lib/qc-spa-auth.js';

const app = document.getElementById('app');

async function handleCallback() {
  try {
    await initQcAuth();
    window.location.replace(consumeQcReturnPath());
  } catch {
    app.replaceChildren();
    const message = document.createElement('p');
    message.textContent = 'AIND login could not be completed. Return to the QC page and try again.';
    app.appendChild(message);
  }
}

handleCallback();

