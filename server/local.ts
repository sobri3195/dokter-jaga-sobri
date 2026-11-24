import { createServer } from 'node:http'
import handler from './http'

createServer(handler).listen(3001, '127.0.0.1', () => console.log('API siap pada port 3001'))
