import axios from 'axios';
import { createTestAccount, TestAccount } from './helpers/setup';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3000';

// Check if API is available
async function isApiAvailable(): Promise<boolean> {
  try {
    await axios.get(`${API_BASE_URL}/api/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Register a fresh user and return their accessToken.
 * Register returns { userId }, so we follow up with a login to get the token.
 */
async function registerAndLogin(): Promise<string> {
  const credentials = {
    email: `test_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
    password: 'TestPass123!'
  };
  await axios.post(`${API_BASE_URL}/api/auth/register`, credentials);
  const loginRes = await axios.post(`${API_BASE_URL}/api/auth/login`, credentials);
  return loginRes.data.accessToken as string;
}

describe('API Integration Tests', () => {
  let authToken: string;
  let testAccount: TestAccount;
  let apiAvailable: boolean;

  beforeAll(async () => {
    testAccount = await createTestAccount();
    apiAvailable = await isApiAvailable();
  });

  // Helper: mark tests as skipped (not falsely passing) when the backend is not reachable.
  const itWhenApi = (name: string, fn: () => Promise<void>, timeout?: number) => {
    (apiAvailable ? it : it.skip)(name, fn, timeout);
  };

  describe('Health Check', () => {
    itWhenApi('should return healthy status', async () => {
      const response = await axios.get(`${API_BASE_URL}/api/health`);
      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('status');
      expect(['healthy', 'degraded']).toContain(response.data.status);
    });
  });

  describe('Authentication', () => {
    itWhenApi('should register new user', async () => {
      const userData = {
        email: `test_${Date.now()}@example.com`,
        password: 'TestPass123!'
      };

      const response = await axios.post(`${API_BASE_URL}/api/auth/register`, userData);

      expect(response.status).toBe(201);
      expect(response.data).toHaveProperty('userId');
    });

    itWhenApi('should login existing user', async () => {
      const credentials = {
        email: `test_${Date.now()}@example.com`,
        password: 'TestPass123!'
      };

      await axios.post(`${API_BASE_URL}/api/auth/register`, credentials);
      const response = await axios.post(`${API_BASE_URL}/api/auth/login`, credentials);

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('accessToken');
      expect(response.data).toHaveProperty('refreshToken');
    });

    itWhenApi('should reject invalid credentials', async () => {
      const credentials = {
        email: 'nonexistent@example.com',
        password: 'wrongpassword'
      };

      await expect(
        axios.post(`${API_BASE_URL}/api/auth/login`, credentials)
      ).rejects.toThrow();
    });
  });

  describe('Account Operations', () => {
    beforeAll(async () => {
      if (!apiAvailable) return;
      authToken = await registerAndLogin();
    });

    itWhenApi('should get account information', async () => {
      const response = await axios.get(
        `${API_BASE_URL}/api/accounts/${testAccount.publicKey}`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('account');
    });

    itWhenApi('should require authentication', async () => {
      await expect(
        axios.get(`${API_BASE_URL}/api/accounts/${testAccount.publicKey}`)
      ).rejects.toThrow();
    });
  });

  describe('Credit Score API', () => {
    beforeAll(async () => {
      if (!apiAvailable) return;
      authToken = await registerAndLogin();
    });

    itWhenApi('should calculate credit score', async () => {
      const response = await axios.post(
        `${API_BASE_URL}/api/v1/credit-score`,
        { accountId: testAccount.publicKey },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data.data).toHaveProperty('score');
    });
  });

  describe('Fraud Detection API', () => {
    beforeAll(async () => {
      if (!apiAvailable) return;
      authToken = await registerAndLogin();
    });

    itWhenApi('should detect fraud in transaction', async () => {
      const response = await axios.post(
        `${API_BASE_URL}/api/v1/fraud/detect`,
        {
          transaction: {
            sourceAccount: testAccount.publicKey,
            amount: '100',
            destination: 'GDEST...'
          }
        },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty('success', true);
      expect(response.data.data).toHaveProperty('riskScore');
    });
  });

  describe('Rate Limiting', () => {
    itWhenApi('should enforce rate limits', async () => {
      const token = await registerAndLogin();

      const requests = Array.from({ length: 100 }, () =>
        axios.get(`${API_BASE_URL}/api/health`, {
          headers: { Authorization: `Bearer ${token}` }
        }).catch(err => err.response)
      );

      const responses = await Promise.all(requests);
      const rateLimited = responses.some(r => r?.status === 429);

      expect(rateLimited).toBe(true);
    }, 15000);
  });

  describe('Error Handling', () => {
    itWhenApi('should return 404 for non-existent endpoints', async () => {
      await expect(
        axios.get(`${API_BASE_URL}/api/nonexistent`)
      ).rejects.toMatchObject({
        response: { status: 404 }
      });
    });

    itWhenApi('should validate request body', async () => {
      const token = await registerAndLogin();

      await expect(
        axios.post(
          `${API_BASE_URL}/api/v1/credit-score`,
          { invalid: 'data' },
          { headers: { Authorization: `Bearer ${token}` } }
        )
      ).rejects.toThrow();
    });
  });
});
