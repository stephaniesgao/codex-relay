/** A failed read is retryable; an uncertain write never is. */
export class ObservationUnavailable extends Error {
 constructor(message:string){super(message);this.name='ObservationUnavailable';}
}
export function observationError(error:any):Error {
 if(error instanceof ObservationUnavailable)return error;
 if(['ENOENT','ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT'].includes(error?.code))return new ObservationUnavailable('Desktop connection unavailable ('+error.code+')');
 return error instanceof Error?error:Error(String(error));
}
export function prefixObservation(prefix:string,error:any):Error {
 return error instanceof ObservationUnavailable?new ObservationUnavailable(prefix+': '+error.message):Error(prefix+': '+error.message);
}
