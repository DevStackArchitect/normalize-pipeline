import { Config } from '../config';
import { SourceAdapter } from '../domain/types';
import { createGcalAdapter } from './gcal';
import { createHubspotAdapter } from './hubspot';
import { createRazorpayAdapter } from './razorpay';

export function createAdapters(config: Config): SourceAdapter[] {
  return [
    createHubspotAdapter(config.HUBSPOT_ACCESS_TOKEN),
    createRazorpayAdapter(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET),
    createGcalAdapter(config.GOOGLE_SERVICE_ACCOUNT_JSON, config.GOOGLE_CALENDAR_ID),
  ];
}
