/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)', '<rootDir>/scripts/*.test.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|react-navigation|@react-navigation/.*|react-native-ble-plx|drizzle-orm)',
  ],
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/app/**',
    '!src/shared/generated/**',
  ],
  coverageThreshold: {
    './src/ble/': { lines: 90, branches: 85 },
    './src/services/': { lines: 90, branches: 85 },
  },
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
};
