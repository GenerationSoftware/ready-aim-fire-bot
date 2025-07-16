import { http, type HttpTransport } from 'viem';
import type { Env } from '../Env';

export function createAuthenticatedHttpTransport(url: string, env: Env): HttpTransport {
  const headers: Record<string, string> = {};
  
  if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASSWORD) {
    const credentials = btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASSWORD}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }
  
  return http(url, {
    fetchOptions: {
      headers
    }
  });
}