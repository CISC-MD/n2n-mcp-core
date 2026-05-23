import { FastifyPluginAsync } from 'fastify';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const agentRoutes: FastifyPluginAsync = async (fastify, options) => {
  fastify.post('/v1/agent/execute', async (request: any, reply) => {
    const { user_input } = request.body || {};
    
    // Эмуляция обработки основного LLM агента
    // Сюда попадают только запросы, прошедшие Semantic WAF
    fastify.log.info({ user_input }, 'Processing safe agent request');
    
    return reply.send({
      status: 'success',
      agent_response: `Успешная обработка безопасного запроса главным агентом. Input: ${user_input}`,
      timestamp: new Date().toISOString()
    });
  });

  // Эндпоинт для запуска сгенерированного кода в песочнице
  fastify.post('/v1/agent/sandbox/run', async (request: any, reply) => {
    const { code } = request.body || {};
    
    if (!code) {
      return reply.status(400).send({ error: 'No code provided for sandbox execution' });
    }

    try {
      fastify.log.info('Executing code in sandbox');
      
      // Путь к sandbox_runner.py
      const runnerPath = path.resolve(__dirname, '../../../../sandbox/sandbox_runner.py');
      
      // Запускаем через Docker fallback по умолчанию для локальной разработки
      const { stdout, stderr } = await execFileAsync('python3', [runnerPath, '--docker', '--code', code], {
        timeout: 35000 // Чуть больше чем тайм-аут самого скрипта
      });

      return reply.send({
        status: 'success',
        sandbox_output: stdout,
        sandbox_error: stderr,
        timestamp: new Date().toISOString()
      });
      
    } catch (error: any) {
      fastify.log.error({ err: error }, 'Sandbox execution failed');
      return reply.status(500).send({
        status: 'error',
        message: 'Sandbox execution failed',
        details: error.stdout || error.message
      });
    }
  });
};

export default agentRoutes;
