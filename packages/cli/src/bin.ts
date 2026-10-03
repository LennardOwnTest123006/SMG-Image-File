import { main } from './smg.ts';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
