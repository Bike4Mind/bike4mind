// Implementation lives in @bike4mind/common so client code can import it
// without pulling the utils barrel (node-only deps) into the browser bundle.
export { usdToCredits, usdToCreditsStochastic } from '@bike4mind/common';
