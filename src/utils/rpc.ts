import { http, webSocket, type HttpTransport, type WebSocketTransport } from 'viem';
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

export function createAuthenticatedWebSocketTransport(url: string, env: Env, options?: any): WebSocketTransport {
  const headers: Record<string, string> = {};
  
  if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASSWORD) {
    const credentials = btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASSWORD}`);
    headers['Authorization'] = `Basic ${credentials}`;
  }
  
  // Convert HTTP URL to WebSocket URL if needed
  let wsUrl = url;
  if (wsUrl.startsWith('http://')) {
    wsUrl = wsUrl.replace('http://', 'ws://');
  } else if (wsUrl.startsWith('https://')) {
    wsUrl = wsUrl.replace('https://', 'wss://');
  }
  
  return webSocket(wsUrl, {
    ...options,
    // WebSocket options including headers for the upgrade request
    webSocketOptions: {
      headers
    }
  });
}