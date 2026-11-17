// Node and OpenSSL settings that would send a secret through a proxy, trust certificates other
// than the usual roots, or write TLS session keys to a file. Code that sends a token (the Square
// clients, ScaleConnect, the certificate scripts) refuses to run while any of them is set.

const VARS = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF'];

const FLAGS = /--(use-env-proxy|use-openssl-ca|use-system-ca|openssl-config|openssl-shared-config|tls-keylog)\b/;

/**
 * The name of the first risky variable that is set, 'flag' for a risky Node flag (in NODE_OPTIONS
 * or on the command line), or null when there is none. Node reads an underscore in a flag name as
 * a hyphen, so both spellings are checked.
 */
export function riskyEnvironment(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): string | null {
  for (const v of VARS) if (env[v]) return v;
  const risky = (text: string): boolean => FLAGS.test(text.replace(/_/g, '-'));
  if (risky(env.NODE_OPTIONS ?? '') || execArgv.some(risky)) return 'flag';
  return null;
}
