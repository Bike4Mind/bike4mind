import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';
import rule from '../../eslint-rules/no-content-in-log-message.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.afterAll = afterAll;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const invalid = (code, name) => ({ code, errors: [{ messageId: 'content', data: { name } }] });

tester.run('no-content-in-log-message', rule, {
  valid: [
    'logger.info("Question received", { questionLength: question.length });',
    'logger.info(`Query expansion: ${query.length} chars`);',
    'req.logger.info("Searching", { query });',
    'logger.debug(`Raw response: ${llmResponse}`);',
    'logger.info(`Using model ${modelId}`);',
    'metrics.log(prompt);',
    'console.log(`Prompt length: ${prompt.length}`);',
  ],
  invalid: [
    invalid('logger.info(`Question: "${question.slice(0, 50)}"`);', 'question'),
    invalid('req.logger.info(`Query: ${query}`);', 'query'),
    invalid('req.logger?.info?.(`Query: ${query}`);', 'query'),
    invalid('logger.error("Raw:", generatedData.substring(0, 500));', 'generatedData'),
    invalid('this.logger.warn("Raw " + llmResponse);', 'llmResponse'),
    invalid('context.logger.log("query:", query);', 'query'),
    invalid('logger?.log("Querying:", params.query);', 'query'),
    invalid('console.log(`Database Searcher query: ${query}`);', 'query'),
    invalid('imageLogger.info(`Prompt: ${cleanPrompt.substring(0, 100)}`);', 'cleanPrompt'),
    invalid('logger.error(`Invalid message: ${body}`);', 'body'),
    invalid('Logger.warn("Invalid event", body);', 'body'),
  ],
});
