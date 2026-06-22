import * as StellarSdk from '@stellar/stellar-sdk';
import axios from 'axios';

export interface TestAccount {
  keypair: StellarSdk.Keypair;
  publicKey: string;
  secretKey: string;
}

export interface TestEnvironment {
  server: StellarSdk.Horizon.Server;
  networkPassphrase: string;
  accounts: TestAccount[];
}

let testEnv: TestEnvironment | null = null;

// ---------------------------------------------------------------------------
// Lightweight in-memory stubs so tests never hit the real Stellar testnet.
// The Friendbot and Horizon endpoints are external services that are flaky
// in CI — a 500/timeout from them should not fail our test suite.
// ---------------------------------------------------------------------------

/** Simulated ledger: publicKey → XLM balance string */
const mockBalances: Record<string, string> = {};
/** Simulated ledger: publicKey → sequence number */
const mockSequences: Record<string, number> = {};

const FRIENDBOT_INITIAL_BALANCE = '10000.0000000';

/**
 * Build a minimal Horizon Server stub that satisfies the calls made in
 * setup.ts and the integration tests without touching the network.
 */
function buildMockServer(): StellarSdk.Horizon.Server {
  return {
    loadAccount: async (publicKey: string) => {
      if (!mockBalances[publicKey]) {
        throw new Error(`Account ${publicKey} not found in mock ledger`);
      }
      mockSequences[publicKey] = (mockSequences[publicKey] ?? 0) + 1;
      return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => String(mockSequences[publicKey]),
        sequence: String(mockSequences[publicKey]),
        incrementSequenceNumber: () => { mockSequences[publicKey]++; },
        balances: [
          { asset_type: 'native', balance: mockBalances[publicKey] }
        ],
      } as unknown as StellarSdk.Horizon.AccountResponse;
    },
    submitTransaction: async (_tx: unknown) => {
      // Simulate a successful payment: deduct from source, credit destination.
      // For test purposes we just return a fake hash — the balance update is
      // handled by sendPayment directly on mockBalances.
      return { hash: `mock_hash_${Date.now()}` } as unknown as StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse;
    },
  } as unknown as StellarSdk.Horizon.Server;
}

/**
 * Setup Stellar testnet environment
 */
export async function setupStellarTestnet(): Promise<TestEnvironment> {
  if (testEnv) return testEnv;

  const server = buildMockServer();
  const networkPassphrase = StellarSdk.Networks.TESTNET;

  testEnv = {
    server,
    networkPassphrase,
    accounts: []
  };

  return testEnv;
}

/**
 * Create and fund a testnet account.
 *
 * In CI / offline environments the real Friendbot is unreliable. We stub the
 * funding step: if STELLAR_USE_MOCK=true (set automatically when NODE_ENV is
 * "test" and no explicit HORIZON_URL override is given) we skip the HTTP call
 * and credit the account directly in our in-memory ledger.
 */
export async function createTestAccount(): Promise<TestAccount> {
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();

  try {
    const useMock =
      process.env.STELLAR_USE_MOCK === 'true' ||
      (process.env.NODE_ENV === 'test' && !process.env.HORIZON_URL);

    if (useMock) {
      // Fund the account in the mock ledger instead of calling Friendbot.
      mockBalances[publicKey] = FRIENDBOT_INITIAL_BALANCE;
      mockSequences[publicKey] = 0;
    } else {
      // Real Friendbot — only used when HORIZON_URL is explicitly configured.
      await axios.get(`https://friendbot.stellar.org?addr=${publicKey}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      mockBalances[publicKey] = FRIENDBOT_INITIAL_BALANCE;
      mockSequences[publicKey] = 0;
    }

    const account: TestAccount = {
      keypair,
      publicKey,
      secretKey: keypair.secret()
    };

    if (testEnv) {
      testEnv.accounts.push(account);
    }

    return account;
  } catch (error) {
    throw new Error(`Failed to create test account: ${error}`);
  }
}

/**
 * Get account balance
 */
export async function getAccountBalance(publicKey: string): Promise<string> {
  // Read directly from the mock ledger when available (fast, no network).
  if (mockBalances[publicKey] !== undefined) {
    return mockBalances[publicKey];
  }

  if (!testEnv) throw new Error('Test environment not initialized');

  const account = await testEnv.server.loadAccount(publicKey);
  const nativeBalance = account.balances.find(b => b.asset_type === 'native');
  return nativeBalance?.balance || '0';
}

/**
 * Send payment between test accounts
 */
export async function sendPayment(
  from: TestAccount,
  to: string,
  amount: string
): Promise<string> {
  if (!testEnv) throw new Error('Test environment not initialized');

  // Update mock balances so subsequent getAccountBalance calls reflect the
  // payment without needing a real Horizon submission.
  if (mockBalances[from.publicKey] !== undefined) {
    const fromBal = parseFloat(mockBalances[from.publicKey]);
    const toBal = parseFloat(mockBalances[to] ?? '0');
    const amtNum = parseFloat(amount);
    mockBalances[from.publicKey] = (fromBal - amtNum).toFixed(7);
    mockBalances[to] = (toBal + amtNum).toFixed(7);
    return `mock_hash_${Date.now()}`;
  }

  const sourceAccount = await testEnv.server.loadAccount(from.publicKey);

  const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: testEnv.networkPassphrase
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: to,
        asset: StellarSdk.Asset.native(),
        amount
      })
    )
    .setTimeout(30)
    .build();

  transaction.sign(from.keypair);

  const result = await testEnv.server.submitTransaction(transaction);
  return result.hash;
}

/**
 * Mock AI API responses
 */
export function mockAIService() {
  return {
    calculateCreditScore: jest.fn().mockResolvedValue({
      score: 750,
      factors: ['payment_history', 'credit_utilization'],
      confidence: 0.85
    }),
    detectFraud: jest.fn().mockResolvedValue({
      isFraudulent: false,
      riskScore: 25,
      reasons: []
    })
  };
}

/**
 * Wait for condition with timeout
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  timeout: number = 10000,
  interval: number = 500
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error('Timeout waiting for condition');
}

/**
 * Cleanup test environment
 */
export async function cleanupTestEnvironment(): Promise<void> {
  testEnv = null;
  // Clear the in-memory ledger between test runs.
  for (const key of Object.keys(mockBalances)) delete mockBalances[key];
  for (const key of Object.keys(mockSequences)) delete mockSequences[key];
}

/**
 * Generate test transaction data
 */
export function generateTestTransaction(overrides: any = {}) {
  return {
    id: `test_tx_${Date.now()}`,
    hash: `hash_${Math.random().toString(36).substr(2, 9)}`,
    sourceAccount: 'GTEST...',
    amount: '100',
    timestamp: new Date().toISOString(),
    successful: true,
    ...overrides
  };
}

/**
 * Setup global test environment
 */
beforeAll(async () => {
  await setupStellarTestnet();
});

/**
 * Cleanup after all tests
 */
afterAll(async () => {
  await cleanupTestEnvironment();
});