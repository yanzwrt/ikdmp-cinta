const webPush = require('web-push');

const keys = webPush.generateVAPIDKeys();

console.log('VAPID Public Key:');
console.log(keys.publicKey);
console.log('');
console.log('VAPID Private Key:');
console.log(keys.privateKey);
console.log('');
console.log('Tambahkan ke env/settings:');
console.log(`push_vapid_public_key=${keys.publicKey}`);
console.log(`push_vapid_private_key=${keys.privateKey}`);
console.log('push_vapid_subject=mailto:admin@example.com');
