/**
 * multi-session-providers.js — the platforms that have a multi-session view.
 *
 * The one file to edit when a new platform grows one: write a provider (see
 * the contract in multi-session.js) and add it here. Providers are tried in
 * order and the one covering the most of the selection wins.
 */

import { dynamicForagingProvider } from './dynamic-foraging-multi.js';

export const MULTI_SESSION_PROVIDERS = [
  dynamicForagingProvider,
];
