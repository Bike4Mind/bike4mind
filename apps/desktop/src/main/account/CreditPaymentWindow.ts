import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { BrowserWindow, session } from 'electron';

export interface CreditPayment {
  clientSecret: string;
  publishableKey: string;
  credits: number;
  price: number;
}

export function paymentHtml(payment: CreditPayment, origin: string, nonce: string): string {
  const data = JSON.stringify({ ...payment, origin }).replaceAll('<', '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Buy credits - Bike4Mind</title><style>
body{font:16px system-ui;background:#fff;color:#18212a;margin:0;padding:32px}main{max-width:480px;margin:auto}h1{font-size:24px}p{color:#52606d}button{background:#086bcf;color:white;padding:14px;border:0;border-radius:8px;width:100%;font:inherit;margin-top:24px;cursor:pointer}button:disabled{opacity:.5}#message{white-space:pre-wrap;margin-top:16px}
</style><script src="https://js.stripe.com/v3/"></script></head><body><main>
<h1 id="title">Buy credits</h1><p>One-time purchase for your personal B4M account.</p>
<form id="form"><div id="payment"></div><button id="pay" disabled>Loading secure payment...</button></form>
<p id="message" role="status"></p></main><script nonce="${nonce}">
const data=${data};
const message=document.getElementById('message'),button=document.getElementById('pay');
document.getElementById('title').textContent='Buy '+data.credits.toLocaleString()+' credits for '+new Intl.NumberFormat(undefined,{style:'currency',currency:'USD'}).format(data.price);
function settled(intent){
 if(intent.status==='succeeded'){message.textContent='Payment received. Close this window to refresh your balance. Credits may take a moment to arrive.';document.getElementById('form').hidden=true;return true;}
 if(intent.status==='processing'||intent.status==='requires_action'){message.textContent='Payment is pending. Follow any payment instructions, then close this window. Credits are added after payment is confirmed.';button.disabled=true;return true;}
 return false;
}
async function start(){
 const stripe=Stripe(data.publishableKey);
 if(location.pathname.endsWith('/return')){
  const result=await stripe.retrievePaymentIntent(data.clientSecret);
  if(result.error)throw new Error(result.error.message);
  if(result.paymentIntent&&settled(result.paymentIntent))return;
 }
 const elements=stripe.elements({clientSecret:data.clientSecret});
 const payment=elements.create('payment');payment.mount('#payment');
 payment.on('ready',()=>{button.disabled=false;button.textContent='Pay securely';});
 payment.on('loaderror',()=>{message.textContent='Could not load the payment form. Close this window and try again.';});
 document.getElementById('form').addEventListener('submit',async event=>{
  event.preventDefault();if(button.disabled)return;button.disabled=true;message.textContent='';
  try{
   const result=await stripe.confirmPayment({elements,confirmParams:{return_url:data.origin+'/return'},redirect:'if_required'});
   if(result.error)message.textContent=result.error.message||'Payment could not be completed.';
   else if(result.paymentIntent&&settled(result.paymentIntent))return;
   else message.textContent='Payment is not confirmed. Check your balance before trying again.';
  }catch{message.textContent='Could not confirm payment. Check your balance before trying again.';}
  button.disabled=false;
 });
}
start().catch(()=>{message.textContent='Could not load secure payment. Close this window and try again.';});
</script></body></html>`;
}

export async function openCreditPayment(payment: CreditPayment, isCurrent: () => boolean): Promise<void> {
  const nonce = randomBytes(24).toString('hex');
  const paymentSession = session.fromPartition(`credit-payment-${randomBytes(16).toString('hex')}`);
  paymentSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  let origin = '';
  const server = createServer((req, res) => {
    if (
      req.headers.host !== new URL(origin).host ||
      req.method !== 'GET' ||
      !URL.canParse(req.url ?? '/', origin) ||
      ![`/${nonce}`, `/${nonce}/return`].includes(new URL(req.url ?? '/', origin).pathname)
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}' https://js.stripe.com; frame-src https://js.stripe.com https://hooks.stripe.com; connect-src https://api.stripe.com https://*.stripe.com; img-src https://*.stripe.com data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(paymentHtml(payment, `${origin}/${nonce}`, nonce));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Payment server unavailable');
    origin = `http://127.0.0.1:${address.port}`;
    if (!isCurrent()) throw new Error('Account changed');
    const window = new BrowserWindow({
      width: 560,
      height: 760,
      title: 'Buy credits - Bike4Mind',
      autoHideMenuBar: true,
      webPreferences: { session: paymentSession, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowNavigation = (event: Electron.Event, target: string) => {
      try {
        const url = new URL(target);
        if (
          !url.username &&
          !url.password &&
          (url.origin === origin ||
            (url.protocol === 'https:' &&
              !url.port &&
              ['js.stripe.com', 'hooks.stripe.com', 'checkout.stripe.com'].includes(url.hostname)))
        )
          return;
      } catch {
        // Malformed navigation targets must be denied too.
      }
      event.preventDefault();
    };
    window.webContents.on('will-navigate', allowNavigation);
    window.webContents.on('will-redirect', allowNavigation);
    const accountGuard = setInterval(() => {
      if (!isCurrent() && !window.isDestroyed()) window.close();
    }, 500);
    try {
      const closed = new Promise<void>(resolve => window.once('closed', resolve));
      await window.loadURL(`${origin}/${nonce}`);
      await closed;
    } finally {
      clearInterval(accountGuard);
      if (!window.isDestroyed()) window.destroy();
    }
  } finally {
    server.closeAllConnections();
    server.close();
    await paymentSession.clearStorageData();
  }
}
