export interface Settings {
  npmUrl: string;
  identity: string;
  baseDomain: string;
  forwardHost: string;
  certificateId: number;
  proxyHost: string;
  proxyPort: number;
  expectedIp: string;
  protectedDomains: string[];
}
export interface Port {
  hostPort: number;
  containerPort: number;
  protocol: string;
  hostIp: string;
  eligible: boolean;
}
export interface Service {
  id: string;
  name: string;
  project: string;
  service: string;
  state: string;
  ports: Port[];
}
export interface Certificate {
  id: number;
  nice_name: string;
  domain_names: string[];
  expires_on: string;
  provider: string;
}
export interface Host {
  id: number;
  domain_names: string[];
  forward_host: string;
  forward_port: number;
  forward_scheme: string;
  certificate_id: number;
  enabled: boolean;
  ssl_forced: boolean;
  allow_websocket_upgrade: boolean;
  advanced_config: string;
  locations: unknown[];
  access_list_id: number;
  meta: Record<string, unknown>;
  [key: string]: unknown;
}
export interface Binding {
  npmId: number;
  project: string;
  service: string;
  containerPort: number | null;
  archived: boolean;
}
export interface Entry extends Host {
  fingerprint: string;
  binding: Binding | null;
  editable: boolean;
  protected: boolean;
}
export interface Input {
  subdomain: string;
  port: number;
  scheme: 'http' | 'https';
  certificateId: number;
  websocket: boolean;
  project: string;
  service: string;
  containerPort: number | null;
}
export interface Operation {
  id: string;
  key: string;
  action: string;
  npmId: number | null;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  before: Host | null;
  after: Host | null;
  request: Record<string, unknown>;
}
export interface CheckResult {
  at: string;
  dns: { ok: boolean; message: string };
  tls: { ok: boolean; message: string };
  http: { ok: boolean; message: string };
  phone: string;
}
