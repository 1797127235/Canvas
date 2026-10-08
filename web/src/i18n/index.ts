import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import zhCN from "@/i18n/locales/zh-CN";

i18n.use(initReactI18next).init({
    resources: { "zh-CN": { translation: zhCN } },
    lng: "zh-CN",
    fallbackLng: "zh-CN",
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
});

export default i18n;
