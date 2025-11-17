import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUid } from '../../../../lib/authServer';
import { getUserSettingsServer, addEventServer } from '../../../../lib/firestoreAdmin';
import type { SchoolProfile, SchoolClass, ClassTiming } from '../../../../lib/firestore';

export async function POST(req: NextRequest) {
  try {
    let uid = await getAuthenticatedUid(req);
    
    // 開発環境で認証が取得できない場合、リクエストボディから取得を試みる
    if (!uid && process.env.NODE_ENV === 'development') {
      console.warn('[School Generate] No UID from auth, attempting to get from request');
      // クライアント側で設定されたUIDを使用（開発専用）
      // 本番環境では必ず認証を通すこと
      uid = 'development-user-uid'; // 仮のUID
    }
    
    if (!uid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { uid: bodyUid, school_id, start_date, end_date } = body;
    
    // リクエストボディにUIDが含まれている場合は、それを使用（開発環境用）
    if (bodyUid && process.env.NODE_ENV === 'development') {
      uid = bodyUid;
      console.log('[School Generate] Using UID from request body:', uid);
    }
    
    if (!start_date || !end_date) {
      return NextResponse.json(
        { error: 'start_date and end_date are required' },
        { status: 400 }
      );
    }

    // uidがnullでないことを確認
    if (!uid) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ユーザー設定から学校プロファイルを取得
    const settings = await getUserSettingsServer(uid);
    console.log('[School Generate] User settings:', JSON.stringify(settings, null, 2));
    
    // school_profiles（複数形）から最新のプロファイルを取得
    const school = settings.school_profiles?.[0] || settings.school_profile;
    
    console.log('[School Generate] School profile:', school ? {
      name: school.name,
      scheduleCount: school.schedule?.length || 0,
      timingsCount: school.timings?.length || 0,
      hasRules: !!school.rules,
      vacationsCount: school.vacations?.length || 0
    } : 'NOT FOUND');
    
    if (!school) {
      return NextResponse.json(
        { error: 'School profile not found. Please register your timetable first.' },
        { status: 404 }
      );
    }
    
    if (!school.schedule || school.schedule.length === 0) {
      return NextResponse.json(
        { error: 'School schedule is empty. Please register your timetable first.' },
        { status: 404 }
      );
    }
    
    if (!school.timings || school.timings.length === 0) {
      return NextResponse.json(
        { error: 'School timings not set. Please set class times first.' },
        { status: 404 }
      );
    }

    console.log('[School Generate] Generating classes for', school.name);

    // 日本の祝日リスト（2025年）
    const japaneseHolidays2025 = [
      '2025-01-01', '2025-01-13', '2025-02-11', '2025-02-23', '2025-02-24',
      '2025-03-20', '2025-04-29', '2025-05-03', '2025-05-04', '2025-05-05',
      '2025-05-06', '2025-07-21', '2025-08-11', '2025-09-15', '2025-09-23',
      '2025-10-13', '2025-11-03', '2025-11-23', '2025-11-24'
    ];

    const start = new Date(start_date);
    const end = new Date(end_date);
    const generatedEvents = [];

    // 日付をイテレート
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      // ローカル時間で日付文字列を生成（タイムゾーンのずれを防ぐ）
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      // 祝日チェック
      if (school.rules?.national_holidays_jp === 'OFF' && japaneseHolidays2025.includes(dateStr)) {
        console.log('[School Generate] Skipping holiday:', dateStr);
        continue;
      }
      
      // 長期休暇チェック
      const monthDay = `${month}-${day}`;
      const isVacation = school.vacations?.some((v: any) => {
        return v?.start && v?.end && monthDay >= v.start && monthDay <= v.end;
      });
      
      if (isVacation) {
        console.log('[School Generate] Skipping vacation day:', dateStr);
        continue;
      }
      
      // 曜日を取得
      const dayOfWeek = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][date.getDay()];
      
      // その曜日の授業を取得
      const classesForDay = school.schedule.filter((c: SchoolClass) => c.day === dayOfWeek);
      
      // 各授業の予定を生成
      for (const cls of classesForDay) {
        try {
          const timing = school.timings?.find((t: ClassTiming) => t.period === cls.period);
          if (!timing) {
            console.log('[School Generate] No timing found for period', cls.period);
            continue;
          }
          
          if (!timing.start || !timing.end) {
            console.log('[School Generate] Invalid timing for period', cls.period, timing);
            continue;
          }
          
          const [startHour, startMin] = timing.start.split(':').map(Number);
          const [endHour, endMin] = timing.end.split(':').map(Number);
          
          const startTime = new Date(date);
          startTime.setHours(startHour, startMin, 0, 0);
          
          const endTime = new Date(date);
          endTime.setHours(endHour, endMin, 0, 0);
          
          const event = {
            title: cls.subject || '授業',
            description: `${cls.period}限`,
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString(),
            category: 'work_study' as const,
            location: cls.location || null,
            source: 'aimo_school_timetable' as const,
            external_id: `school_${school_id}_${dateStr}_${cls.period}`,
            external_calendar_id: school_id,
            is_read_only: false, // 編集・削除可能
            sync_status: null
          };
          
          generatedEvents.push(event);
        } catch (err) {
          console.error('[School Generate] Error generating event for class:', cls, err);
          // エラーが発生した授業はスキップして続行
          continue;
        }
      }
    }

    console.log('[School Generate] Generated', generatedEvents.length, 'class events');

    if (generatedEvents.length === 0) {
      return NextResponse.json(
        { 
          success: false,
          error: 'No events were generated. Please check your timetable settings.',
          generated_count: 0
        },
        { status: 400 }
      );
    }

    // Firestoreに一括保存
    let savedCount = 0;
    const errors = [];
    
    for (const event of generatedEvents) {
      try {
        await addEventServer(uid, event);
        savedCount++;
      } catch (err: any) {
        console.error('[School Generate] Failed to save event:', event, err);
        errors.push({ event: event.title, error: err.message });
      }
    }
    
    console.log('[School Generate] Saved', savedCount, 'out of', generatedEvents.length, 'events');
    
    if (errors.length > 0) {
      console.error('[School Generate] Errors during save:', errors);
    }

    return NextResponse.json({
      success: true,
      generated_count: generatedEvents.length,
      saved_count: savedCount,
      errors: errors.length > 0 ? errors : undefined,
      message: `${savedCount}件の授業予定を生成しました${errors.length > 0 ? `（${errors.length}件のエラー）` : ''}`
    });
  } catch (error: any) {
    console.error('[School Generate API] Error:', error);
    console.error('[School Generate API] Error stack:', error?.stack);
    return NextResponse.json(
      { 
        error: error?.message || 'Failed to generate school schedule',
        details: error?.stack || 'No stack trace available'
      },
      { status: 500 }
    );
  }
}

