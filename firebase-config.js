// ============================================================
// 임대관리 웹앱 - Firebase 연결 설정
// ============================================================
// 아래 값을 Firebase 콘솔에서 복사해서 붙여넣으세요.
//
// [값 찾는 방법]
//  1) https://console.firebase.google.com 접속 → 프로젝트 선택
//  2) 왼쪽 위 톱니바퀴(⚙) → "프로젝트 설정" 클릭
//  3) 아래쪽 "내 앱" → 웹 앱( </> 아이콘 )이 없으면 "앱 추가"로 웹 앱 생성
//  4) 표시되는 firebaseConfig 값을 아래 따옴표 안에 그대로 붙여넣기
//
// ⚠ 주의: 이 파일은 GitHub 공개 저장소에 올라갑니다.
//    apiKey 등은 Firebase 보안 규칙(firestore.rules)으로 보호되므로
//    공개되어도 괜찮지만, 입주자 개인정보(이름·전화번호)는
//    절대 코드에 넣지 마세요. 데이터는 로그인 후 '데이터 불러오기'로 넣습니다.
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyDfxW-Mu2pqn189wKtkzKqeXffSF4rjiHY",
  authDomain: "hoonhee-rentmanage.firebaseapp.com",
  projectId: "hoonhee-rentmanage",
  storageBucket: "hoonhee-rentmanage.firebasestorage.app",
  messagingSenderId: "57549946919",
  appId: "1:57549946919:web:a81fdba7cf987396d84e02"
};
