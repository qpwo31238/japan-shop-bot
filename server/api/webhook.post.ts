// server/api/webhook.post.ts
import {
  Client,
  WebhookEvent,
  FlexMessage,
  FlexBubble,
  FlexComponent,
} from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';

import { scrapeGeneric } from '../utils/scrapeGeneric';
import { scrapeHyod } from '../utils/scrapeHyod';
import { scrapeShopify } from '../utils/scrapeShopify';
import { checkProductRestriction } from '../utils/productFilterRules';

// 🔑 老闆的 User ID
const ADMIN_USER_ID = 'Ud2d92728dfaf5241e62b1cb167e6973a';

export default defineEventHandler(async (event) => {
  console.log('🔥🔥🔥 Webhook 收到請求！🔥🔥🔥');

  const config = useRuntimeConfig();
  const client = new Client({
    channelAccessToken: config.line.channelAccessToken,
    channelSecret: config.line.channelSecret,
  });

  // 🔑 初始化 Supabase 客戶端
  const supabase = createClient(
    config.public.supabaseUrl,
    config.public.supabaseKey,
  );
  // const supabase = createClient('https://nvjdoyvfqirutumsvbmy.supabase.co', 'sb_publishable_YuroylBYd91dLKYhSF-yMA_plP7C-wx')

  const body = await readRawBody(event);
  if (!body) return 'No Body';
  const bodyJson = JSON.parse(body);
  const events: WebhookEvent[] = bodyJson.events || [];

  await Promise.all(
    events.map(async (webhookEvent) => {
      const userId = webhookEvent.source.userId;

      // --- 1. 處理 Postback (點擊加入購物車按鈕) ---
      if (webhookEvent.type === 'postback' && userId) {
        const data = new URLSearchParams(webhookEvent.postback.data);
        const action = data.get('action');

        if (action === 'buy') {
          const itemTitle = data.get('item') || '未知商品';
          const itemColor = data.get('color') || 'F';
          const itemSize = data.get('size') || 'F';
          const itemPrice = data.get('price') || '¥0';
          const itemImg = data.get('img') || '';

          console.log(`🛒 嘗試寫入資料庫: ${itemTitle}`);

          // 🔍 先檢查是否已存在相同的商品（避免重複）
          const { data: existingItems } = await supabase
            .from('cart_items')
            .select('id')
            .eq('user_id', userId)
            .eq('product_title', itemTitle)
            .eq('color', itemColor)
            .eq('size', itemSize)
            .limit(1);

          if (existingItems && existingItems.length > 0) {
            // 已存在，直接回覆
            await client.replyMessage(webhookEvent.replyToken, {
              type: 'text',
              text: `ℹ️ 此商品已在購物車中！\n\n商品：${itemTitle}\n顏色：${itemColor}\n尺寸：${itemSize}\n\n🛒 點擊選單「查看購物車」即可查看。`,
            });
          } else {
            // 不存在，新增
            const { error } = await supabase.from('cart_items').insert({
              user_id: userId,
              product_title: itemTitle,
              color: itemColor,
              size: itemSize,
              price: itemPrice,
              image_url: itemImg,
            });

            if (error) {
              console.error('❌ Supabase 錯誤:', error.message);
              await client.replyMessage(webhookEvent.replyToken, {
                type: 'text',
                text: `抱歉，加入失敗。原因：${error.message}`,
              });
            } else {
              await client.replyMessage(webhookEvent.replyToken, {
                type: 'text',
                text: `✅ 已成功加入購物車！\n\n商品：${itemTitle}\n顏色：${itemColor}\n尺寸：${itemSize}\n\n🛒 點擊選單「查看購物車」即可查看所有商品。`,
              });
            }
          }
        }
        return;
      }

      // --- 2. 處理文字訊息 (原有邏輯) ---
      if (
        webhookEvent.type !== 'message' ||
        webhookEvent.message.type !== 'text'
      )
        return;
      const userText = webhookEvent.message.text.trim();

      // 🔍 查 ID
      if (userText === '查ID') {
        await client.replyMessage(webhookEvent.replyToken, {
          type: 'text',
          text: `您的 User ID 是：\n${userId}`,
        });
        return;
      }

      // 🚨 攔截「專人客服」
      if (userText.startsWith('🙋‍♂️')) {
        await client.replyMessage(webhookEvent.replyToken, {
          type: 'text',
          text: '收到您的詢問！👩‍💻\n專員正在確認日本庫存與今日匯率，請稍候，我們會盡快以人工回覆您！',
        });
        let userName = '未知客戶';
        try {
          const profile = await client.getProfile(userId);
          userName = profile.displayName;
        } catch (e) {}
        if (ADMIN_USER_ID) {
          try {
            await client.pushMessage(ADMIN_USER_ID, {
              type: 'text',
              text: `🔔 新的報價請求！\n------------------\n👤 客人：${userName}\n\n📝 內容：\n${userText}`,
            });
          } catch (err) {}
        }
        return;
      }

      if (!userText.startsWith('http')) return;

      // 🛑 簡單網址快篩
      let isProductUrl = true;
      if (
        (userText.includes('56-design.com') ||
          userText.includes('autorimessa.com')) &&
        !userText.includes('/products/')
      )
        isProductUrl = false;
      if (
        userText.includes('hyod-products.com') &&
        !userText.includes('/item/') &&
        !userText.includes('ProductDetail')
      )
        isProductUrl = false;

      if (!isProductUrl) {
        await client.replyMessage(webhookEvent.replyToken, {
          type: 'text',
          text: '💡 這是「分類頁」或「首頁」喔！請貼單一商品的網址～',
        });
        return;
      }

      try {
        console.log(`🕷️ 收到網址：${userText}`);
        let productData = null;

        if (
          userText.includes('56-design.com') ||
          userText.includes('/products/') ||
          userText.includes('autorimessa.com')
        ) {
          productData = await scrapeShopify(userText);
        }

        if (!productData) {
          const { data: html } = await axios.get(userText, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const $ = cheerio.load(html);
          if (userText.includes('hyod-products.com'))
            productData = scrapeHyod($, userText);
          else productData = scrapeGeneric($, userText);
        }

        if (!productData) throw new Error('無法識別的網站資料');

        console.log(`✅ 抓取成功：${productData.title}`);

        // 👮‍♂️ 安檢
        const { isRestricted } = checkProductRestriction(
          productData.title,
          productData.productType,
          productData.tags,
          userText,
        );

        // ✨ 56design 安全帽判定
        const is56DesignHelmet =
          userText.includes('56-design.com') && productData.isHelmet;

        const safeVariants = productData.variants.slice(0, 10);

        // 🎨 製作卡片
        const bubbles: FlexBubble[] = safeVariants.map((v) => {
          const safeTitle =
            productData!.title.length > 20
              ? productData!.title.substring(0, 20) + '...'
              : productData!.title;

          const sizeButtons: FlexComponent[] = v.sizes.map((size: string) => {
            const isSoldOut = size.includes('缺貨') || size.includes('已售完');

            // 🚨 56design 安全帽：按鈕變成紅色，點擊送出文字
            if (is56DesignHelmet) {
              return {
                type: 'box',
                layout: 'vertical',
                justifyContent: 'center',
                alignItems: 'center',
                height: '40px',
                margin: 'md',
                borderWidth: '1px',
                borderColor: '#ff5555',
                cornerRadius: '4px',
                backgroundColor: '#fff0f0',
                action: {
                  type: 'message',
                  label: size, // 按鈕上顯示尺寸
                  text: '此商品請務必點擊下方「專人報價回覆」，感謝你的配合。', // 點擊後發送的文字
                },
                contents: [
                  {
                    type: 'text',
                    text: size + ' | 需專人報價',
                    color: '#ff5555',
                    align: 'center',
                    weight: 'bold',
                    size: 'sm',
                  },
                ],
              };
            }

            // 👮‍♂️ 違禁品
            if (isRestricted) {
              return {
                type: 'box',
                layout: 'vertical',
                justifyContent: 'center',
                alignItems: 'center',
                height: '40px',
                margin: 'md',
                borderWidth: '1px',
                borderColor: '#ff5555',
                cornerRadius: '4px',
                backgroundColor: '#fff0f0',
                action: {
                  type: 'message',
                  label: size,
                  text: `🙋‍♂️ 您好！我想詢問這款「特殊商品」的報價：\n\n商品：${productData!.title}\n顏色：${v.color}\n尺寸：${size}\n\n系統提示此商品可能含有禁運成分，請協助確認。`,
                },
                contents: [
                  {
                    type: 'text',
                    text: size + ' | 需人工確認',
                    color: '#ff5555',
                    align: 'center',
                    weight: 'bold',
                    size: 'sm',
                  },
                ],
              };
            }

            // 🌑 缺貨
            if (isSoldOut) {
              return {
                type: 'box',
                layout: 'vertical',
                justifyContent: 'center',
                alignItems: 'center',
                height: '40px',
                margin: 'md',
                borderWidth: '1px',
                borderColor: '#dcdcdc',
                cornerRadius: '4px',
                backgroundColor: '#f0f0f0',
                action: { type: 'uri', label: size, uri: userText },
                contents: [
                  {
                    type: 'text',
                    text: '❌ 已售完',
                    color: '#aaaaaa',
                    align: 'center',
                    weight: 'bold',
                    size: 'sm',
                  },
                ],
              };
            }

            // 🟢 正常
            return {
              type: 'box',
              layout: 'vertical',
              justifyContent: 'center',
              alignItems: 'center',
              height: '40px',
              margin: 'md',
              borderWidth: '1px',
              borderColor: '#000000',
              cornerRadius: '4px',
              backgroundColor: '#ffffff',
              action: {
                type: 'postback',
                label: size,
                data: `action=buy&item=${encodeURIComponent(productData!.title)}&color=${encodeURIComponent(v.color)}&size=${encodeURIComponent(size)}&price=${encodeURIComponent(v.price)}&img=${encodeURIComponent(v.image)}`,
                displayText: `我要加入購物車：\n${productData!.title}\n顏色：${v.color}\n尺寸：${size}`,
              },
              contents: [
                {
                  type: 'text',
                  text: size + ' | 加入購物車',
                  color: '#000000',
                  align: 'center',
                  weight: 'bold',
                  size: 'sm',
                },
              ],
            };
          });

          return {
            type: 'bubble',
            size: 'mega',
            hero: {
              type: 'image',
              url: v.image,
              size: 'full',
              aspectRatio: '1:1',
              aspectMode: 'fit',
              backgroundColor: '#ffffff',
              action: { type: 'uri', uri: userText },
            },
            body: {
              type: 'box',
              layout: 'vertical',
              paddingAll: 'xl',
              contents: [
                {
                  type: 'text',
                  text: 'RECOMMENDED ITEM',
                  weight: 'bold',
                  size: 'xxs',
                  color: '#b0b0b0',
                },
                {
                  type: 'text',
                  text: productData!.title,
                  weight: 'bold',
                  size: 'md',
                  margin: 'sm',
                  wrap: true,
                  color: '#333333',
                },
                {
                  type: 'text',
                  text: v.color === '單一款式' ? 'ONE COLOR' : v.color,
                  size: 'xs',
                  color: '#999999',
                  margin: 'xs',
                },
                {
                  type: 'text',
                  text: v.price,
                  size: '3xl',
                  color: '#000000',
                  weight: 'bold',
                  margin: 'md',
                },

                // 違禁品提示
                ...(isRestricted
                  ? [
                      {
                        type: 'text' as const,
                        text: '⚠️ 此商品含有禁運成分，無法直接結帳。',
                        size: 'xs',
                        color: '#ff5555',
                        wrap: true,
                        margin: 'md',
                      },
                    ]
                  : []),

                // ✨ 56design 安全帽專用提示 (卡片上顯示紅字)
                ...(is56DesignHelmet
                  ? [
                      {
                        type: 'text' as const,
                        text: '⚠️ 此商品請務必點擊下方「專人報價回覆」，感謝你的配合。',
                        size: 'xs',
                        color: '#ff0000',
                        weight: 'bold',
                        wrap: true,
                        margin: 'md',
                      },
                    ]
                  : []),

                { type: 'separator', margin: 'xxl', color: '#f0f0f0' },
                {
                  type: 'box',
                  layout: 'vertical',
                  margin: 'lg',
                  contents: [
                    // 安全帽改變小標題
                    {
                      type: 'text',
                      text: 'SIZE SELECT',
                      size: is56DesignHelmet ? 'xs' : 'xxs',
                      color: is56DesignHelmet ? '#000000' : '#cccccc',
                      weight: 'bold',
                      align: 'center',
                      margin: 'sm',
                    },
                    ...(sizeButtons.length > 0
                      ? sizeButtons
                      : [
                          {
                            type: 'text',
                            text: '請前往官網選擇尺寸',
                            size: 'xs',
                            color: '#aaaaaa',
                            align: 'center',
                            margin: 'md',
                          },
                        ]),
                  ],
                },
                { type: 'separator', margin: 'xxl', color: '#f0f0f0' },

                {
                  type: 'box',
                  layout: 'vertical',
                  justifyContent: 'center',
                  alignItems: 'center',
                  height: '40px',
                  margin: 'xl',
                  borderWidth: '1px',
                  cornerRadius: '4px',
                  backgroundColor: '#3b3b3b',
                  action: {
                    type: 'message',
                    label: '專人客服',
                    text: is56DesignHelmet
                      ? `此商品請務必點擊下方「專人報價回覆」，感謝你的配合。\n\n(我要詢問：${productData!.title})`
                      : `🙋‍♂️ 您好！我想詢問這款商品的專人報價：\n\n商品：${productData!.title}\n顏色：${v.color}\n尺寸：(請填寫)\n\n請協助確認庫存與含稅報價，謝謝！`,
                  },
                  contents: [
                    {
                      type: 'text',
                      text: '專人報價回覆',
                      color: '#ffffff',
                      align: 'center',
                      weight: 'bold',
                      size: 'sm',
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'vertical',
                  justifyContent: 'center',
                  alignItems: 'center',
                  height: '40px',
                  margin: 'md',
                  borderWidth: '1px',
                  cornerRadius: '4px',
                  backgroundColor: '#3b3b3b',
                  action: { type: 'uri', label: '回官方商品頁', uri: userText },
                  contents: [
                    {
                      type: 'text',
                      text: '回官方商品頁',
                      color: '#ffffff',
                      align: 'center',
                      weight: 'bold',
                      size: 'sm',
                    },
                  ],
                },
              ],
            },
          };
        });

        const flexMessage: FlexMessage = {
          type: 'flex',
          altText: `推薦商品：${productData.title}`,
          contents: { type: 'carousel', contents: bubbles },
        };

        await client.replyMessage(webhookEvent.replyToken, flexMessage);
        console.log('✅ 訊息發送成功！');
      } catch (err: any) {
        console.error('❌ 失敗:', err.message);
        await client.replyMessage(webhookEvent.replyToken, {
          type: 'text',
          text: '抱歉，讀取網頁發生錯誤 > <',
        });
      }
    }),
  );
  return 'OK';
});
