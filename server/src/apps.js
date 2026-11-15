// Где скачать приложение для каждой системы — для бота («Помощь» → «Скачать приложение») и
// страницы ключа в кабинете.
//
// Ссылки официальные: App Store и Google Play — карточки AmneziaVPN; компьютеры и APK для
// Android — страница последнего выпуска на GitHub (amnezia-vpn/amnezia-client): она всегда ведёт на
// свежую версию, а GitHub из РФ открывается (amnezia.org бывает недоступен). На iPhone с российским
// Apple ID AmneziaVPN в App Store нет — его замена от тех же разработчиков DefaultVPN, ключи те же.

const RELEASES = 'https://github.com/amnezia-vpn/amnezia-client/releases/latest';
const APP_STORE = 'https://apps.apple.com/app/amneziavpn/id1600529900';
const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=org.amnezia.vpn';

// Порядок — как в выборе системы в боте
const SYSTEMS = ['ios', 'android', 'windows', 'macos', 'linux'];

function appLinks(config) {
  return {
    ios: {
      title: '🍏 iPhone / iPad',
      note: 'AmneziaVPN — в App Store. Если у вас российский Apple ID, AmneziaVPN там нет: установите DefaultVPN от тех же разработчиков — ключ подходит, дальше всё так же.',
      links: [
        { text: 'AmneziaVPN — App Store', url: APP_STORE },
        { text: 'Российский Apple ID — DefaultVPN', url: config.iosRuAppUrl }
      ]
    },
    android: {
      title: '🤖 Android',
      note: 'AmneziaVPN — в Google Play. Если Google Play недоступен, скачайте APK с GitHub: на странице выпуска в разделе Assets — файл с «android11+» в названии (для Android 9–10 — «android9-10»), откройте его и разрешите установку. Нужен Android 9 или новее.',
      links: [
        { text: 'AmneziaVPN — Google Play', url: GOOGLE_PLAY },
        { text: 'APK для Android — GitHub', url: RELEASES }
      ]
    },
    windows: {
      title: '🪟 Windows',
      note: 'На странице выпуска на GitHub в разделе Assets скачайте установщик с «windows» в названии (.exe) и запустите его. Нужна Windows 10 (1809 или новее) или 11, 64 бит.',
      links: [{ text: 'AmneziaVPN для Windows — GitHub', url: RELEASES }]
    },
    macos: {
      title: '🍎 macOS',
      note: 'На странице выпуска на GitHub в разделе Assets скачайте файл с «macos» в названии (.pkg) и установите его.',
      links: [{ text: 'AmneziaVPN для macOS — GitHub', url: RELEASES }]
    },
    linux: {
      title: '🐧 Linux',
      note: 'На странице выпуска на GitHub в разделе Assets скачайте файл с «linux» в названии, распакуйте и запустите установщик.',
      links: [{ text: 'AmneziaVPN для Linux — GitHub', url: RELEASES }]
    }
  };
}

// Ссылки для платформы устройства из кабинета (androidtv — как Android)
function linksForPlatform(config, platform) {
  const all = appLinks(config);
  return all[platform === 'androidtv' ? 'android' : platform] ?? null;
}

export { appLinks, linksForPlatform, SYSTEMS, RELEASES, APP_STORE, GOOGLE_PLAY };
