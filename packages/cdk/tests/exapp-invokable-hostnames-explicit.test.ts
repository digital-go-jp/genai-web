import { describe, expect, test } from 'vitest';
import { selfHostingTemplateParams } from '../env-parameters/self-hosting-template';

describe('every environment defined in this repository sets exAppInvokableHostnames explicitly', () => {
  test('the self-hosting template', () => {
    expect(selfHostingTemplateParams.exAppInvokableHostnames).toBeDefined();
  });
});
