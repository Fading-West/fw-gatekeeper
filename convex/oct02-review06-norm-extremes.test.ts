import {expect,it} from 'vitest';
import {isSupportedEncoding} from '../src/lib/encoding';
it('rejects finite extreme templates whose Python squared norm is zero or infinite',()=>{
 for(const magnitude of [1e308,1e-300]){const vector=Array(512).fill(0);vector[0]=magnitude;expect(isSupportedEncoding(vector)).toBe(false);}
 expect(isSupportedEncoding(Array(512).fill(.1))).toBe(true);
});
