import requests

cookies = {
    # 'anonymous_id': '1a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002',
    # 'unique_user_id': 'p96ussw220nq9h-6eb9049-1a0c1e14e70-58ew562qu',
    # '_bl_uid': 'q5msFvURu3tlCg54Oam6xywi8spR',
    # '_c_WBKFRo': 'OpCQtHa1ty34LrqtnHDRxytFrR5CZsjB3JKrBYvp',
    # 'acw_tc': '2f72701f17944694998367612e7e0007e3ff72001d8d04ef464807effbbc6e',
    # 'sensorsdata2015session': '%7B%7D',
    # 'ipCityCode': '110100',
    # 'citycode': '{%22provinceName%22:%22%E5%8C%97%E4%BA%AC%E5%B8%82%22%2C%22cityName%22:%22%E5%8C%97%E4%BA%AC%E5%B8%82%22%2C%22provinceCode%22:110000%2C%22cityCode%22:110100%2C%22districtName%22:%22%E4%B8%9C%E5%9F%8E%E5%8C%BA%22%2C%22districtCode%22:110101}',
    # 'p_pub_key': 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5fVWaf/t4t2lQG9RvhxoEiOOj/bQXBZYCwNLWtpPREiWJxj2e35j4QiA1HWSTBC9sO97AiuOYWp3IIpNb34MNjUkHGXlhjYcmtCb7JAxs6Do7QjHexm6oUGRN4pZj8ok541Z2bWu2VrQbtY/I0JWl5F83L51jK65LzKT555QlNwIDAQAB',
    # 'p_pub_gr': '1794463212441',
    # 'acw_sc__v3': '6af56ea161c4d2f2ca9080406b27db555edc85b7',
    # 'page_request_id': '960f93cc-ff41-4e1c-8b73-980a55b636ca',
    'sensorsdata2015jssdkcross': '%7B%22distinct_id%22%3A%221a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_landing_page%22%3A%22https%3A%2F%2Fwww.zkh.com%2Fitem%2FAC0788.html%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMWExOGI3OTlkNjg2NTYtMDdkYzBhNjRmZWNlNTgtMjYwNzFmNTEtMjA3MzYwMC0xYTE4Yjc5OWQ2OTEwMDIifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%221a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002%22%7D',
    # 'JSESSIONID': '677774AF094F06175B39CA6E461BBB4B',
    # 'ssxmod_itna': '1-Qqjx2DgQD=DQqBK4YQTPGqiQYb=vDzxC5iOODuxiK08D6DYqGdq2XXEGKCddi=XYDWuDqXDZRitDlOYYYDSxD6FDK4GTG86BbwCelPjExIXBmQ2LKQk0po_n3PtiE8cA6u9/kltAT5nDGD0aDmKDU=GrdD4DxOPD5xDTDWeDGDD3DmmhDi5oD0KDjWgIz/gpDYPDEWoDYxDra/YDR=xD0PPhDQ9oatWq79DDBci2=mirj/3hub_UCt0LK7ipD7yoDlai7qj6OX1qw/8nTLfbN40kAq0Osb4EKfkQ7F3Afzn43ZR_1ZRPGeeIimdGD5WGPOGKlpsDh4eAeajE1xznpmWrinPDneYGDKZBk/HS7vMGvlD2V4b/YG8GG//Tez23q4xUD5Rrt9rN/x4GDHQbiSDxS2d4_rbBriDYtRdWbe8i3riqGiO74DXOHb8djYKPD',
    # 'ssxmod_itna2': '1-Qqjx2DgQD=DQqBK4YQTPGqiQYb=vDzxC5iOODuxiK08D6DYqGdq2XXEGKCddi=XYDWuDqXDZRDYD=x80P4GiCOxGaGCExaveD0Hi6W=jDxydWuFGLhxWkOGG9PzkkBMGHfrnKAFqCsOFdd09DxxbqGmY_dITtMnuNYCcN5Fow=YD',
}

headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': 'https://www.zkh.com',
    'priority': 'u=1, i',
    'referer': 'https://www.zkh.com/item/AC0788.html',
    'sec-ch-ua': '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
    'x-sc-anonymous-id': '1a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002',
    # 'cookie': 'anonymous_id=1a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002; unique_user_id=p96ussw220nq9h-6eb9049-1a0c1e14e70-58ew562qu; _bl_uid=q5msFvURu3tlCg54Oam6xywi8spR; _c_WBKFRo=OpCQtHa1ty34LrqtnHDRxytFrR5CZsjB3JKrBYvp; acw_tc=2f72701f17944694998367612e7e0007e3ff72001d8d04ef464807effbbc6e; sensorsdata2015session=%7B%7D; ipCityCode=110100; citycode={%22provinceName%22:%22%E5%8C%97%E4%BA%AC%E5%B8%82%22%2C%22cityName%22:%22%E5%8C%97%E4%BA%AC%E5%B8%82%22%2C%22provinceCode%22:110000%2C%22cityCode%22:110100%2C%22districtName%22:%22%E4%B8%9C%E5%9F%8E%E5%8C%BA%22%2C%22districtCode%22:110101}; p_pub_key=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC5fVWaf/t4t2lQG9RvhxoEiOOj/bQXBZYCwNLWtpPREiWJxj2e35j4QiA1HWSTBC9sO97AiuOYWp3IIpNb34MNjUkHGXlhjYcmtCb7JAxs6Do7QjHexm6oUGRN4pZj8ok541Z2bWu2VrQbtY/I0JWl5F83L51jK65LzKT555QlNwIDAQAB; p_pub_gr=1794463212441; acw_sc__v3=6af56ea161c4d2f2ca9080406b27db555edc85b7; page_request_id=960f93cc-ff41-4e1c-8b73-980a55b636ca; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%221a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_landing_page%22%3A%22https%3A%2F%2Fwww.zkh.com%2Fitem%2FAC0788.html%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMWExOGI3OTlkNjg2NTYtMDdkYzBhNjRmZWNlNTgtMjYwNzFmNTEtMjA3MzYwMC0xYTE4Yjc5OWQ2OTEwMDIifQ%3D%3D%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%2C%22%24device_id%22%3A%221a18b799d68656-07dc0a64fece58-26071f51-2073600-1a18b799d691002%22%7D; JSESSIONID=677774AF094F06175B39CA6E461BBB4B; ssxmod_itna=1-Qqjx2DgQD=DQqBK4YQTPGqiQYb=vDzxC5iOODuxiK08D6DYqGdq2XXEGKCddi=XYDWuDqXDZRitDlOYYYDSxD6FDK4GTG86BbwCelPjExIXBmQ2LKQk0po_n3PtiE8cA6u9/kltAT5nDGD0aDmKDU=GrdD4DxOPD5xDTDWeDGDD3DmmhDi5oD0KDjWgIz/gpDYPDEWoDYxDra/YDR=xD0PPhDQ9oatWq79DDBci2=mirj/3hub_UCt0LK7ipD7yoDlai7qj6OX1qw/8nTLfbN40kAq0Osb4EKfkQ7F3Afzn43ZR_1ZRPGeeIimdGD5WGPOGKlpsDh4eAeajE1xznpmWrinPDneYGDKZBk/HS7vMGvlD2V4b/YG8GG//Tez23q4xUD5Rrt9rN/x4GDHQbiSDxS2d4_rbBriDYtRdWbe8i3riqGiO74DXOHb8djYKPD; ssxmod_itna2=1-Qqjx2DgQD=DQqBK4YQTPGqiQYb=vDzxC5iOODuxiK08D6DYqGdq2XXEGKCddi=XYDWuDqXDZRDYD=x80P4GiCOxGaGCExaveD0Hi6W=jDxydWuFGLhxWkOGG9PzkkBMGHfrnKAFqCsOFdd09DxxbqGmY_dITtMnuNYCcN5Fow=YD',
}

# params = {
#     'md5__1101': '2790552d-hboEYpohpwpzqjwdF6W6WNBjf/EuELevpKeuYWeXAhVeiAPXtogRYLobKzvMwSLCopoGtCWpXjurWpUucWh_OW8EeieWQj9u2TjfUW6EpwWbBwjWAQjoCYWzjgeWoAgEQWvxUWm7WvQcWjjutjEu5WPRSWPOm1E_bWPTUzfTCtWOOtotJoW_pkfdj7M_bth7EW',
# }

TEST_IDS = [
    'AC0788',
    'CH7631',
    'AC0790',
    'AA4220627',
    'CH7634',
    'PC8029',
    'AE8258028',
    'CH2781',
    'AE8258022',
    'AE2747348',
]
proxies = {
    'http': 'http://t19412847231184:mayirsug@a719.kdltps.com:15818',
    'https': 'http://t19412847231184:mayirsug@a719.kdltps.com:15818',
}
for test_id in TEST_IDS:
    json_data = {
        'skuNo': test_id,
        'keyword': '',
        'page': 1,
        'pageSize': 5,
    }

    response = requests.post(
        'https://www.zkh.com/servezkhApi/goods/1/selectSpec',
        cookies=cookies,
        headers=headers,
        json=json_data,
        proxies=proxies
    )

    print(response.text)