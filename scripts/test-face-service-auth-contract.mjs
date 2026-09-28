import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const faceService = readFileSync('face-service/main.py', 'utf8');
const dockerfile = readFileSync('face-service/Dockerfile', 'utf8');
const requirements = readFileSync('face-service/requirements.txt', 'utf8');
const enrollmentRoute = readFileSync('src/app/api/enroll/route.ts', 'utf8');
const renderConfig = readFileSync('render.yaml', 'utf8');

assert.match(faceService, /dependencies=\[Depends\(require_face_service_key\)\]/, 'Sensitive face endpoints must require the service key dependency');
assert.match(faceService, /allow_origins=get_allowed_cors_origins\(\)/, 'Face-service CORS must use the restricted origin list');
assert.match(enrollmentRoute, /process\.env\.FACE_SERVICE_KEY/, 'Enrollment must fail closed when the face-service key is missing');
assert.match(enrollmentRoute, /['"]x-face-service-key['"]:\s*faceServiceKey/, 'Enrollment must authenticate its face-service request');
assert.match(renderConfig, /name:\s*fw-gatekeeper[\s\S]*key:\s*FACE_SERVICE_KEY[\s\S]*sync:\s*false/, 'Dashboard service must declare the face-service secret');
assert.match(renderConfig, /name:\s*fw-face-service[\s\S]*key:\s*FACE_SERVICE_KEY[\s\S]*sync:\s*false/, 'Face service must declare the same secret name');
assert.doesNotMatch(faceService, /allow_origins=\[\s*['"]\*['"]\s*\]/, 'Face-service CORS must never allow every origin');
assert.match(dockerfile, /COPY\s+main\.py\s+face_auth\.py\s+enrollment_quality\.py\s+\.\//, 'The face-service image must include its authentication and enrollment-quality modules');
assert.match(requirements, /^opencv-python-headless==4\.11\.0\.86$/m, 'The face service must use the verified OpenCV runtime with Haar cascade support');

console.log('Face service authentication contract passed');
